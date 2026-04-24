from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from clash_controller import ClashConfig, ClashNodeSwitcher, parse_exclude_keywords


class ParseExcludeKeywordsTests(unittest.TestCase):
    def test_accepts_common_separators_and_dedupes(self) -> None:
        keywords = parse_exclude_keywords("香港, HK，剩余流量\n官网|HK")

        self.assertEqual(keywords, ("香港", "HK", "剩余流量", "官网"))


class ClashNodeSelectionTests(unittest.TestCase):
    def test_filters_direct_reject_and_keyword_matches(self) -> None:
        switcher = ClashNodeSwitcher(
            ClashConfig(exclude_keywords=("香港", "官网")),
            logger=lambda message: None,
        )

        candidates = switcher._candidate_nodes(
            {
                "all": [
                    "DIRECT",
                    "REJECT",
                    "香港 01",
                    "美国 01",
                    "官网剩余流量",
                    "日本 01",
                ]
            }
        )

        self.assertEqual(candidates, ["美国 01", "日本 01"])

    def test_picks_next_node_after_current(self) -> None:
        switcher = ClashNodeSwitcher(ClashConfig(), logger=lambda message: None)

        self.assertEqual(
            switcher._pick_next_node(["美国 01", "日本 01", "新加坡 01"], "日本 01"),
            "新加坡 01",
        )

    def test_wraps_to_first_node(self) -> None:
        switcher = ClashNodeSwitcher(ClashConfig(), logger=lambda message: None)

        self.assertEqual(
            switcher._pick_next_node(["美国 01", "日本 01"], "日本 01"),
            "美国 01",
        )


class ClashSwitchConfirmationTests(unittest.TestCase):
    def test_switch_waits_until_group_now_matches_target(self) -> None:
        class FakeSwitcher(ClashNodeSwitcher):
            def __init__(self) -> None:
                super().__init__(ClashConfig(), logger=lambda message: None)
                self.requests: list[tuple[str, str, dict[str, str] | None]] = []
                self.group_reads = 0

            def _request_json(self, method: str, path: str, *, body=None):  # type: ignore[no-untyped-def]
                self.requests.append((method, path, body))
                if method == "GET" and path == "/proxies":
                    return {
                        "proxies": {
                            "Proxy": {
                                "now": "Node A",
                                "all": ["Node A", "Node B"],
                            }
                        }
                    }
                if method == "PUT":
                    return {}
                if method == "GET" and path == "/proxies/Proxy":
                    self.group_reads += 1
                    return {"now": "Node B" if self.group_reads >= 2 else "Node A"}
                raise AssertionError(f"Unexpected request: {method} {path}")

        switcher = FakeSwitcher()

        with patch("clash_controller.time.sleep", lambda seconds: None):
            result = switcher.switch_to_next_node("test")

        self.assertEqual(result.previous_node, "Node A")
        self.assertEqual(result.next_node, "Node B")
        self.assertEqual(switcher.group_reads, 2)
        self.assertIn(("PUT", "/proxies/Proxy", {"name": "Node B"}), switcher.requests)


if __name__ == "__main__":
    unittest.main()
