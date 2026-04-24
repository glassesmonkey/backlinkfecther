from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sim_exporter import (
    BacklinkRecord,
    DEFAULT_DATA_BROWSER_PROXY,
    DataBrowserPool,
    ExportRecord,
    NonRetryableTrafficError,
    TrafficRunConfig,
    TrafficStateCache,
    _is_transient_page_evaluate_error,
    calculate_retry_delay_seconds,
    click_next_backlinks_page,
    collect_traffic_records,
    create_csv_text,
    dedupe_backlink_urls,
    is_retryable_traffic_error,
    parse_monthly_visits,
)


class ParseMonthlyVisitsTests(unittest.TestCase):
    def test_prefers_engagments_visits(self) -> None:
        payload = {
            "Engagments": {"Visits": 1234.6},
            "EstimatedMonthlyVisits": {"2024-01": 10, "2024-02": 20},
        }

        self.assertEqual(parse_monthly_visits(payload), 1235)

    def test_falls_back_to_last_estimated_month(self) -> None:
        payload = {
            "EstimatedMonthlyVisits": {"2024-01": 100.2, "2024-02": 567.8},
        }

        self.assertEqual(parse_monthly_visits(payload), 568)


class DedupeBacklinksTests(unittest.TestCase):
    def test_dedupes_by_hostname_and_ignores_invalid_urls(self) -> None:
        urls = [
            "https://example.com/article-a",
            "https://example.com/article-b",
            "notaurl",
            "https://sub.example.com/path",
        ]

        records = dedupe_backlink_urls(urls)

        self.assertEqual(
            [(record.hostname, record.source_url) for record in records],
            [
                ("example.com", "https://example.com/article-a"),
                ("sub.example.com", "https://sub.example.com/path"),
            ],
        )


class CsvGenerationTests(unittest.TestCase):
    def test_writes_header_quotes_and_filters_threshold(self) -> None:
        csv_text = create_csv_text(
            [
                ExportRecord(
                    hostname="example.com",
                    source_url='https://example.com/a,"quoted"',
                    monthly_visits=101,
                ),
                ExportRecord(
                    hostname="skip-me.com",
                    source_url="https://skip-me.com",
                    monthly_visits=100,
                ),
            ]
        )

        self.assertEqual(
            csv_text,
            'hostname,source_url,monthly_visits\n'
            'example.com,"https://example.com/a,""quoted""",101\n',
        )


class BrowserEvaluateErrorTests(unittest.TestCase):
    def test_navigation_context_loss_is_transient(self) -> None:
        error = Exception(
            "Page.evaluate: Execution context was destroyed, most likely because of a navigation."
        )

        self.assertTrue(_is_transient_page_evaluate_error(error))

    def test_unrelated_evaluate_error_is_not_transient(self) -> None:
        self.assertFalse(_is_transient_page_evaluate_error(Exception("ReferenceError: x is not defined")))


class BacklinksPaginationRetryTests(unittest.TestCase):
    def test_transient_click_error_is_treated_as_success_when_page_already_advanced(self) -> None:
        class FakePage:
            def __init__(self) -> None:
                self.click_calls = 0

            def evaluate(self, script, arg=None):  # type: ignore[no-untyped-def]
                self.click_calls += 1
                raise Exception(
                    "Page.evaluate: Execution context was destroyed, most likely because of a navigation."
                )

        page = FakePage()

        with patch("sim_exporter.wait_for_backlinks_advance", return_value={"currentPage": 43}):
            click_next_backlinks_page(
                page,
                previous_page=42,
                previous_first_href="https://example.com/a",
                logger=lambda message: None,
            )

        self.assertEqual(page.click_calls, 1)

    def test_retries_click_when_first_click_did_not_advance(self) -> None:
        class FakePage:
            def __init__(self) -> None:
                self.click_calls = 0

            def evaluate(self, script, arg=None):  # type: ignore[no-untyped-def]
                self.click_calls += 1
                if self.click_calls == 1:
                    return {"clicked": False, "diagnostics": {"nextExists": True}}
                return {"clicked": True}

        page = FakePage()

        with patch("sim_exporter.wait_for_backlinks_advance", return_value={"currentPage": 43}):
            click_next_backlinks_page(
                page,
                previous_page=42,
                previous_first_href="https://example.com/a",
                logger=lambda message: None,
            )

        self.assertEqual(page.click_calls, 2)


class RetryDelayTests(unittest.TestCase):
    def test_uses_exponential_backoff_with_cap(self) -> None:
        self.assertEqual(
            calculate_retry_delay_seconds(
                1,
                base_delay_seconds=60,
                max_delay_seconds=600,
            ),
            60,
        )
        self.assertEqual(
            calculate_retry_delay_seconds(
                5,
                base_delay_seconds=60,
                max_delay_seconds=600,
            ),
            600,
        )


class TrafficErrorClassificationTests(unittest.TestCase):
    def test_marks_common_similarweb_failures_retryable(self) -> None:
        retryable_messages = [
            "Similarweb returned HTTP 403.",
            "Similarweb returned HTTP 429.",
            "Similarweb returned HTTP 500.",
            "Timed out while waiting for Similarweb JSON data.",
            "Similarweb request did not return a browser response.",
            "Diagnostics: non-json body",
        ]

        for message in retryable_messages:
            with self.subTest(message=message):
                self.assertTrue(is_retryable_traffic_error(Exception(message)))


class TrafficStateCacheTests(unittest.TestCase):
    def test_saves_loads_dedupes_and_restores_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = Path(temp_dir) / "state.json"
            cache = TrafficStateCache(
                cache_path,
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )
            cache.set_backlinks(
                [
                    BacklinkRecord("example.com", "https://example.com/a"),
                    BacklinkRecord("example.com", "https://example.com/b"),
                ]
            )
            cache.mark_success(
                BacklinkRecord("example.com", "https://example.com/a"),
                123,
            )

            loaded = TrafficStateCache(
                cache_path,
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )

            self.assertEqual(
                loaded.backlink_records(),
                [BacklinkRecord("example.com", "https://example.com/a")],
            )
            self.assertEqual(
                loaded.export_records(),
                [ExportRecord("example.com", "https://example.com/a", 123)],
            )
            self.assertIsNone(loaded.next_ready_hostname(0))


class FakeDataBrowsers:
    def __init__(self, count: int = 2) -> None:
        self.count = count
        self.current_index = 0
        self.rotations = 0

    def current_page(self) -> object:
        return object()

    def rotate(self, reason: str) -> int:
        self.rotations += 1
        self.current_index = (self.current_index + 1) % self.count
        return self.current_index


class FakeClashSwitcher:
    def __init__(self) -> None:
        self.switches = 0

    def switch_to_next_node(self, reason: str):  # type: ignore[no-untyped-def]
        self.switches += 1
        raise AssertionError("Clash should not switch for non-retryable failures.")


class DataBrowserPoolTests(unittest.TestCase):
    def test_launches_data_browser_with_configured_proxy(self) -> None:
        class FakeChromium:
            def __init__(self) -> None:
                self.kwargs = None

            def launch_persistent_context(self, user_data_dir: str, **kwargs):  # type: ignore[no-untyped-def]
                self.kwargs = kwargs
                return object()

        class FakePlaywright:
            def __init__(self) -> None:
                self.chromium = FakeChromium()

        fake_playwright = FakePlaywright()
        pool = DataBrowserPool(
            fake_playwright,
            count=1,
            proxy_server=DEFAULT_DATA_BROWSER_PROXY,
            logger=lambda message: None,
        )

        pool._launch_context(Path("/tmp/profile"))

        self.assertEqual(
            fake_playwright.chromium.kwargs["proxy"],
            {"server": "http://127.0.0.1:7890"},
        )

    def test_lazily_starts_only_the_current_browser(self) -> None:
        class FakeContext:
            def new_page(self) -> object:
                return object()

        class FakeChromium:
            def __init__(self) -> None:
                self.launch_count = 0

            def launch_persistent_context(self, user_data_dir: str, **kwargs):  # type: ignore[no-untyped-def]
                self.launch_count += 1
                return FakeContext()

        class FakePlaywright:
            def __init__(self) -> None:
                self.chromium = FakeChromium()

        fake_playwright = FakePlaywright()
        with DataBrowserPool(
            fake_playwright,
            count=2000,
            proxy_server=DEFAULT_DATA_BROWSER_PROXY,
            logger=lambda message: None,
        ) as pool:
            self.assertEqual(fake_playwright.chromium.launch_count, 0)
            pool.current_page()
            self.assertEqual(fake_playwright.chromium.launch_count, 1)

    def test_rotate_closes_previous_browser_before_next_lazy_start(self) -> None:
        class FakeContext:
            def __init__(self) -> None:
                self.closed = False

            def new_page(self) -> object:
                return object()

            def close(self) -> None:
                self.closed = True

        class FakeChromium:
            def __init__(self) -> None:
                self.contexts: list[FakeContext] = []

            def launch_persistent_context(self, user_data_dir: str, **kwargs):  # type: ignore[no-untyped-def]
                context = FakeContext()
                self.contexts.append(context)
                return context

        class FakePlaywright:
            def __init__(self) -> None:
                self.chromium = FakeChromium()

        fake_playwright = FakePlaywright()
        with DataBrowserPool(
            fake_playwright,
            count=2,
            proxy_server=DEFAULT_DATA_BROWSER_PROXY,
            logger=lambda message: None,
        ) as pool:
            pool.current_page()
            first_context = fake_playwright.chromium.contexts[0]
            pool.rotate("test")
            self.assertTrue(first_context.closed)
            self.assertEqual(len(fake_playwright.chromium.contexts), 1)
            pool.current_page()
            self.assertEqual(len(fake_playwright.chromium.contexts), 2)


class TrafficCollectionTests(unittest.TestCase):
    def test_failure_enters_delay_queue_then_success_is_cached(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = TrafficStateCache(
                Path(temp_dir) / "state.json",
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )
            backlinks = [BacklinkRecord("example.com", "https://example.com/a")]
            cache.set_backlinks(backlinks)

            with patch(
                "sim_exporter.fetch_monthly_visits",
                side_effect=[RuntimeError("Similarweb returned HTTP 403."), 250],
            ):
                records, deferred_failed_count = collect_traffic_records(
                    cache,
                    backlinks,
                    data_browsers=FakeDataBrowsers(),
                    config=TrafficRunConfig(
                        max_traffic_attempts=8,
                        retry_base_delay_seconds=0,
                        retry_max_delay_seconds=0,
                    ),
                    logger=lambda message: None,
                )

            self.assertEqual(records, [ExportRecord("example.com", "https://example.com/a", 250)])
            self.assertEqual(deferred_failed_count, 0)
            self.assertEqual(cache.attempts("example.com"), 1)

    def test_rotates_data_browser_after_consecutive_failures(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = TrafficStateCache(
                Path(temp_dir) / "state.json",
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )
            backlinks = [BacklinkRecord("example.com", "https://example.com/a")]
            cache.set_backlinks(backlinks)
            data_browsers = FakeDataBrowsers(count=2)

            with patch(
                "sim_exporter.fetch_monthly_visits",
                side_effect=[
                    RuntimeError("Similarweb returned HTTP 403."),
                    RuntimeError("Similarweb returned HTTP 429."),
                ],
            ):
                records, deferred_failed_count = collect_traffic_records(
                    cache,
                    backlinks,
                    data_browsers=data_browsers,
                    config=TrafficRunConfig(
                        data_failure_threshold=2,
                        max_traffic_attempts=2,
                        retry_base_delay_seconds=0,
                        retry_max_delay_seconds=0,
                    ),
                    logger=lambda message: None,
                )

            self.assertEqual(records, [])
            self.assertEqual(deferred_failed_count, 1)
            self.assertEqual(data_browsers.rotations, 1)
            self.assertEqual(cache.state["host_states"]["example.com"]["status"], "deferred_failed")

    def test_ends_run_instead_of_sleeping_when_only_delayed_retries_remain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = TrafficStateCache(
                Path(temp_dir) / "state.json",
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )
            backlinks = [BacklinkRecord("example.com", "https://example.com/a")]
            cache.set_backlinks(backlinks)
            cache.mark_retry(
                "example.com",
                error_message="Similarweb returned HTTP 403.",
                next_retry_at=9999999999,
            )

            with patch("sim_exporter.time.sleep") as sleep:
                records, deferred_failed_count = collect_traffic_records(
                    cache,
                    backlinks,
                    data_browsers=FakeDataBrowsers(),
                    config=TrafficRunConfig(wait_for_delayed_retries=False),
                    logger=lambda message: None,
                )

            self.assertEqual(records, [])
            self.assertEqual(deferred_failed_count, 0)
            sleep.assert_not_called()

    def test_http_400_is_deferred_without_retry_or_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = TrafficStateCache(
                Path(temp_dir) / "state.json",
                source_url="https://sim.3ue.com/#/digitalsuite/acquisition/backlinks/table/x",
                fresh=False,
            )
            backlinks = [BacklinkRecord("bad.example", "https://bad.example/a")]
            cache.set_backlinks(backlinks)
            data_browsers = FakeDataBrowsers(count=2)
            clash_switcher = FakeClashSwitcher()

            with patch(
                "sim_exporter.fetch_monthly_visits",
                side_effect=NonRetryableTrafficError("Similarweb returned HTTP 400 Bad Request."),
            ):
                records, deferred_failed_count = collect_traffic_records(
                    cache,
                    backlinks,
                    data_browsers=data_browsers,
                    clash_switcher=clash_switcher,  # type: ignore[arg-type]
                    config=TrafficRunConfig(),
                    logger=lambda message: None,
                )

            self.assertEqual(records, [])
            self.assertEqual(deferred_failed_count, 1)
            self.assertEqual(data_browsers.rotations, 0)
            self.assertEqual(clash_switcher.switches, 0)
            self.assertEqual(cache.state["queue"], [])
            self.assertEqual(cache.state["host_states"]["bad.example"]["attempts"], 1)
            self.assertEqual(cache.state["host_states"]["bad.example"]["status"], "deferred_failed")


if __name__ == "__main__":
    unittest.main()
