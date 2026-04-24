from __future__ import annotations

import csv
import hashlib
import json
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from clash_controller import ClashConfig, ClashNodeSwitcher

SIM_ORIGIN = "https://sim.3ue.com"
BACKLINKS_HASH_FRAGMENT = "/digitalsuite/acquisition/backlinks/table/"
SIMILARWEB_URL_TEMPLATE = "https://data.similarweb.com/api/v1/data?domain={domain}"
COMMON_CDP_PORTS = (9222, 9223, 9224, 9229)
COMMON_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
PAGE_TIMEOUT_MS = 30_000
TRAFFIC_TIMEOUT_MS = 45_000
POLL_INTERVAL_SECONDS = 1.0
MIN_PAGE_DELAY_SECONDS = 3.0
MAX_PAGE_DELAY_SECONDS = 6.0
MIN_MONTHLY_VISITS = 100
PAGE_ACTION_RETRY_ATTEMPTS = 3
DEFAULT_DATA_BROWSER_COUNT = 2
DEFAULT_DATA_FAILURE_THRESHOLD = 3
DEFAULT_MAX_TRAFFIC_ATTEMPTS = 8
DEFAULT_RETRY_BASE_DELAY_SECONDS = 60
DEFAULT_RETRY_MAX_DELAY_SECONDS = 600
DEFAULT_DATA_BROWSER_PROXY = "http://127.0.0.1:7890"
DATA_BROWSER_STABLE_DELAY_SECONDS = 1.0
CACHE_VERSION = 1

GET_BACKLINKS_SNAPSHOT_JS = """
() => {
  function findBacklinksTableWrapper() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    return wrappers.find((wrapper) => {
      const text = (wrapper.textContent || "").replace(/\\s+/g, " ").trim();
      return text.includes("引用页面标题和网址") && wrapper.querySelector("tbody tr a.ad-target-url");
    }) || null;
  }

  const wrapper = findBacklinksTableWrapper();
  if (!wrapper) {
    return null;
  }

  const anchors = Array.from(wrapper.querySelectorAll("tbody tr a.ad-target-url"));
  const urls = anchors.map((anchor) => anchor.href).filter(Boolean);
  const pagerInput = wrapper.querySelector("li.ant-pagination-simple-pager input");
  const pagerText = wrapper.querySelector("li.ant-pagination-simple-pager")?.textContent || "";
  const totalPagesMatch = pagerText.match(/\\/\\s*(\\d+)/);
  const nextButton = wrapper.querySelector("li.ant-pagination-next");
  const currentPage = pagerInput ? Number(pagerInput.value) : null;
  const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : null;

  if (!urls.length || !currentPage || !totalPages) {
    return null;
  }

  return {
    urls,
    firstHref: urls[0] || null,
    currentPage,
    totalPages,
    hasNext: nextButton ? nextButton.getAttribute("aria-disabled") !== "true" : false
  };
}
"""

CLICK_NEXT_PAGE_JS = """
async () => {
  function collectDiagnostics() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    const wrapper = wrappers.find((candidate) => {
      const text = (candidate.textContent || "").replace(/\\s+/g, " ").trim();
      return text.includes("引用页面标题和网址");
    }) || null;
    const pagerInput = wrapper?.querySelector("li.ant-pagination-simple-pager input");
    const pagerText = wrapper?.querySelector("li.ant-pagination-simple-pager")?.textContent?.trim() || null;
    const nextLi = wrapper?.querySelector("li.ant-pagination-next, li[title='Next Page']") || null;
    return {
      href: location.href,
      title: document.title,
      pagerValue: pagerInput?.value || null,
      pagerText,
      tableFound: Boolean(wrapper),
      nextExists: Boolean(nextLi)
    };
  }

  function findNextButton() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    const wrapper = wrappers.find((candidate) => {
      const text = (candidate.textContent || "").replace(/\\s+/g, " ").trim();
      return text.includes("引用页面标题和网址") && candidate.querySelector("tbody tr a.ad-target-url");
    }) || null;
    if (!wrapper) {
      return null;
    }

    return wrapper.querySelector("li.ant-pagination-next, li[title='Next Page']");
  }

  const nextButton = findNextButton();
  if (!nextButton) {
    return {
      clicked: false,
      error: "未找到下一页按钮",
      diagnostics: collectDiagnostics()
    };
  }

  if (nextButton.getAttribute("aria-disabled") === "true") {
    return {
      clicked: false,
      error: "已经是最后一页",
      diagnostics: collectDiagnostics()
    };
  }

  const target = nextButton.querySelector("button") || nextButton;
  nextButton.scrollIntoView({ block: "center", behavior: "auto" });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const eventNames = ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const eventName of eventNames) {
    target.dispatchEvent(new MouseEvent(eventName, {
      view: window,
      bubbles: true,
      cancelable: true
    }));
  }

  if (typeof target.click === "function") {
    target.click();
  }

  return {
    clicked: true,
    diagnostics: collectDiagnostics()
  };
}
"""

DID_BACKLINKS_PAGE_ADVANCE_JS = """
({ previousPage, previousFirstHref }) => {
  const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
  const wrapper = wrappers.find((candidate) => {
    const text = (candidate.textContent || "").replace(/\\s+/g, " ").trim();
    return text.includes("引用页面标题和网址") && candidate.querySelector("tbody tr a.ad-target-url");
  }) || null;
  if (!wrapper) {
    return false;
  }

  const anchors = Array.from(wrapper.querySelectorAll("tbody tr a.ad-target-url"));
  const urls = anchors.map((anchor) => anchor.href).filter(Boolean);
  const pagerInput = wrapper.querySelector("li.ant-pagination-simple-pager input");
  const pagerText = wrapper.querySelector("li.ant-pagination-simple-pager")?.textContent || "";
  const totalPagesMatch = pagerText.match(/\\/\\s*(\\d+)/);
  const nextButton = wrapper.querySelector("li.ant-pagination-next");
  const currentPage = pagerInput ? Number(pagerInput.value) : null;
  const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : null;

  if (!urls.length || !currentPage || !totalPages) {
    return false;
  }

  const snapshot = {
    urls,
    firstHref: urls[0] || null,
    currentPage,
    totalPages,
    hasNext: nextButton ? nextButton.getAttribute("aria-disabled") !== "true" : false
  };

  if (snapshot.currentPage > previousPage) {
    return snapshot;
  }

  return false;
}
"""

READ_TRAFFIC_SNAPSHOT_JS = """
({ hostname }) => {
  function extractJsonText() {
    const preText = document.querySelector("pre")?.textContent?.trim();
    if (preText) {
      return preText;
    }

    const bodyText = document.body?.innerText?.trim();
    if (bodyText) {
      return bodyText;
    }

    return document.documentElement?.innerText?.trim() || "";
  }

  const rawText = extractJsonText();
  if (!rawText) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return null;
  }

  const requestedHostname = String(hostname || "").toLowerCase();
  const responseHostname = String(data?.Domain || data?.domain || "").toLowerCase();
  if (requestedHostname && responseHostname && requestedHostname !== responseHostname) {
    return null;
  }

  const directVisits = Number(data?.Engagments?.Visits);
  if (Number.isFinite(directVisits)) {
    return {
      hostname: responseHostname || requestedHostname,
      visits: Math.round(directVisits)
    };
  }

  const monthly = data?.EstimatedMonthlyVisits;
  if (monthly && typeof monthly === "object") {
    const values = Object.values(monthly)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (values.length) {
      return {
        hostname: responseHostname || requestedHostname,
        visits: Math.round(values[values.length - 1])
      };
    }
  }

  return null;
}
"""

READ_TRAFFIC_DIAGNOSTICS_JS = """
() => {
  const preText = document.querySelector("pre")?.textContent?.trim() || "";
  const bodyText = document.body?.innerText?.trim() || document.documentElement?.innerText?.trim() || "";
  return {
    url: location.href,
    title: document.title,
    bodySample: (preText || bodyText).slice(0, 300)
  };
}
"""


@dataclass(frozen=True)
class BacklinkRecord:
    hostname: str
    source_url: str


@dataclass(frozen=True)
class ExportRecord:
    hostname: str
    source_url: str
    monthly_visits: int


@dataclass(frozen=True)
class ExportResult:
    output_path: Path
    exported_count: int
    deferred_failed_count: int


class NonRetryableTrafficError(RuntimeError):
    pass


@dataclass(frozen=True)
class TrafficRunConfig:
    fetch_traffic: bool = True
    data_browser_count: int = DEFAULT_DATA_BROWSER_COUNT
    data_failure_threshold: int = DEFAULT_DATA_FAILURE_THRESHOLD
    max_traffic_attempts: int = DEFAULT_MAX_TRAFFIC_ATTEMPTS
    retry_base_delay_seconds: int = DEFAULT_RETRY_BASE_DELAY_SECONDS
    retry_max_delay_seconds: int = DEFAULT_RETRY_MAX_DELAY_SECONDS
    data_browser_proxy: str = DEFAULT_DATA_BROWSER_PROXY
    wait_for_delayed_retries: bool = False
    cache_path: Path | None = None
    fresh: bool = False


def default_output_path() -> Path:
    base_dir = Path(__file__).resolve().parent
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return base_dir / "output" / f"sim-backlinks-{timestamp}.csv"


def default_cache_path(source_url: str) -> Path:
    source_hash = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:16]
    return Path(__file__).resolve().parent / "runtime" / "cache" / f"{source_hash}.json"


def format_cdp_start_hint() -> str:
    return "\n".join(
        [
            "Start Chrome with a DevTools port first, for example:",
            'open -na "/Applications/Google Chrome.app" --args \\',
            "  --remote-debugging-port=9223 \\",
            "  '--remote-allow-origins=*' \\",
            "  --user-data-dir=/tmp/chrome-cdp \\",
            "  about:blank",
        ]
    )


def is_backlinks_page(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == "https" and f"{parsed.scheme}://{parsed.netloc}" == SIM_ORIGIN and BACKLINKS_HASH_FRAGMENT in parsed.fragment


def parse_monthly_visits(payload: dict[str, Any]) -> int | None:
    direct_visits = payload.get("Engagments", {}).get("Visits")
    direct_number = _coerce_number(direct_visits)
    if direct_number is not None:
        return round(direct_number)

    monthly = payload.get("EstimatedMonthlyVisits")
    if not isinstance(monthly, dict):
        return None

    values = [_coerce_number(value) for value in monthly.values()]
    finite_values = [value for value in values if value is not None]
    if not finite_values:
        return None
    return round(finite_values[-1])


def dedupe_backlink_urls(urls: list[str]) -> list[BacklinkRecord]:
    unique: dict[str, BacklinkRecord] = {}
    for href in urls:
        try:
            parsed = urlparse(href)
        except ValueError:
            continue
        hostname = parsed.hostname.lower() if parsed.hostname else ""
        if not hostname or hostname in unique:
            continue
        unique[hostname] = BacklinkRecord(hostname=hostname, source_url=href)
    return list(unique.values())


def filter_export_records(records: list[ExportRecord]) -> list[ExportRecord]:
    return [record for record in records if record.monthly_visits > MIN_MONTHLY_VISITS]


def create_csv_text(records: list[ExportRecord]) -> str:
    filtered = filter_export_records(records)
    buffer = StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["hostname", "source_url", "monthly_visits"])
    for record in filtered:
        writer.writerow([record.hostname, record.source_url, str(record.monthly_visits)])
    return buffer.getvalue()


def create_backlinks_csv_text(records: list[BacklinkRecord]) -> str:
    buffer = StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["hostname", "source_url"])
    for record in sorted(records, key=lambda item: item.hostname):
        writer.writerow([record.hostname, record.source_url])
    return buffer.getvalue()


def write_csv(output_path: Path, records: list[ExportRecord]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(create_csv_text(records), encoding="utf-8")


def write_backlinks_csv(output_path: Path, records: list[BacklinkRecord]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(create_backlinks_csv_text(records), encoding="utf-8")


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temp_path.replace(path)


class TrafficStateCache:
    def __init__(self, path: Path, *, source_url: str, fresh: bool) -> None:
        self.path = path
        self.state = self._new_state(source_url)
        if not fresh and path.exists():
            self.state = self._load_existing_state(path, source_url)

    def set_backlinks(self, backlinks: list[BacklinkRecord]) -> None:
        existing = {record.get("hostname") for record in self.state.get("backlinks", [])}
        for backlink in backlinks:
            if backlink.hostname in existing:
                continue
            self.state["backlinks"].append(
                {"hostname": backlink.hostname, "source_url": backlink.source_url}
            )
            existing.add(backlink.hostname)

        host_states = self.state["host_states"]
        queue = self.state["queue"]
        queued = set(queue)
        for backlink in backlinks:
            host_state = host_states.setdefault(
                backlink.hostname,
                {
                    "attempts": 0,
                    "status": "pending",
                    "last_error": None,
                    "next_retry_at": None,
                },
            )
            if backlink.hostname in self.state["results"]:
                host_state["status"] = "success"
                continue
            if host_state.get("status") == "deferred_failed":
                continue
            if backlink.hostname not in queued:
                queue.append(backlink.hostname)
                queued.add(backlink.hostname)
        self.state["queue"] = [
            hostname for hostname in self.state["queue"] if hostname not in self.state["results"]
        ]
        self.save()

    def backlink_records(self) -> list[BacklinkRecord]:
        records: list[BacklinkRecord] = []
        seen: set[str] = set()
        for raw in self.state.get("backlinks", []):
            hostname = str(raw.get("hostname") or "").strip().lower()
            source_url = str(raw.get("source_url") or "").strip()
            if not hostname or not source_url or hostname in seen:
                continue
            records.append(BacklinkRecord(hostname=hostname, source_url=source_url))
            seen.add(hostname)
        return records

    def export_records(self) -> list[ExportRecord]:
        records: list[ExportRecord] = []
        for raw in self.state.get("results", {}).values():
            hostname = str(raw.get("hostname") or "").strip()
            source_url = str(raw.get("source_url") or "").strip()
            monthly_visits = raw.get("monthly_visits")
            if not hostname or not source_url or not isinstance(monthly_visits, int):
                continue
            records.append(
                ExportRecord(
                    hostname=hostname,
                    source_url=source_url,
                    monthly_visits=monthly_visits,
                )
            )
        records.sort(key=lambda record: record.hostname)
        return records

    def next_ready_hostname(self, now: float) -> str | None:
        for hostname in list(self.state["queue"]):
            host_state = self.state["host_states"].get(hostname, {})
            if host_state.get("status") == "success":
                self.remove_from_queue(hostname)
                continue
            next_retry_at = _coerce_number(host_state.get("next_retry_at"))
            if next_retry_at is None or next_retry_at <= now:
                return hostname
        return None

    def seconds_until_next_retry(self, now: float) -> float | None:
        waits: list[float] = []
        for hostname in self.state["queue"]:
            host_state = self.state["host_states"].get(hostname, {})
            if host_state.get("status") == "success":
                continue
            next_retry_at = _coerce_number(host_state.get("next_retry_at"))
            if next_retry_at is not None:
                waits.append(max(0.0, next_retry_at - now))
        if not waits:
            return None
        return min(waits)

    def mark_success(self, backlink: BacklinkRecord, monthly_visits: int) -> None:
        self.state["results"][backlink.hostname] = {
            "hostname": backlink.hostname,
            "source_url": backlink.source_url,
            "monthly_visits": monthly_visits,
        }
        self.state["host_states"].setdefault(backlink.hostname, {}).update(
            {
                "status": "success",
                "last_error": None,
                "next_retry_at": None,
            }
        )
        self.remove_from_queue(backlink.hostname)
        self.save()

    def mark_retry(
        self,
        hostname: str,
        *,
        error_message: str,
        next_retry_at: float,
    ) -> None:
        host_state = self.state["host_states"].setdefault(hostname, {})
        host_state["attempts"] = int(host_state.get("attempts") or 0) + 1
        host_state["status"] = "retry_waiting"
        host_state["last_error"] = error_message
        host_state["next_retry_at"] = next_retry_at
        if hostname not in self.state["queue"]:
            self.state["queue"].append(hostname)
        self.save()

    def mark_deferred_failed(
        self,
        hostname: str,
        *,
        error_message: str,
        count_attempt: bool = True,
    ) -> None:
        host_state = self.state["host_states"].setdefault(hostname, {})
        current_attempts = int(host_state.get("attempts") or 0)
        host_state["attempts"] = current_attempts + 1 if count_attempt else current_attempts
        host_state["status"] = "deferred_failed"
        host_state["last_error"] = error_message
        host_state["next_retry_at"] = None
        self.remove_from_queue(hostname)
        self.save()

    def attempts(self, hostname: str) -> int:
        host_state = self.state["host_states"].get(hostname, {})
        return int(host_state.get("attempts") or 0)

    def set_runtime_cursor(
        self,
        *,
        current_clash_node: str | None = None,
        current_data_browser_index: int | None = None,
    ) -> None:
        if current_clash_node is not None:
            self.state["current_clash_node"] = current_clash_node
        if current_data_browser_index is not None:
            self.state["current_data_browser_index"] = current_data_browser_index
        self.save()

    def deferred_failed_count(self) -> int:
        return sum(
            1
            for state in self.state["host_states"].values()
            if state.get("status") == "deferred_failed"
        )

    def waiting_retry_count(self) -> int:
        return sum(
            1
            for hostname in self.state["queue"]
            if self.state["host_states"].get(hostname, {}).get("status") != "success"
        )

    def save(self) -> None:
        self.state["updated_at"] = _utc_now_iso()
        atomic_write_json(self.path, self.state)

    def remove_from_queue(self, hostname: str) -> None:
        self.state["queue"] = [queued for queued in self.state["queue"] if queued != hostname]

    def _new_state(self, source_url: str) -> dict[str, Any]:
        return {
            "version": CACHE_VERSION,
            "source_url": source_url,
            "backlinks": [],
            "results": {},
            "queue": [],
            "host_states": {},
            "current_clash_node": None,
            "current_data_browser_index": 0,
            "created_at": _utc_now_iso(),
            "updated_at": _utc_now_iso(),
        }

    def _load_existing_state(self, path: Path, source_url: str) -> dict[str, Any]:
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:
            raise RuntimeError(f"Could not read cache file {path}: {error}") from error

        if not isinstance(loaded, dict):
            raise RuntimeError(f"Cache file {path} did not contain a JSON object.")
        if loaded.get("source_url") != source_url:
            raise RuntimeError(
                f"Cache file {path} belongs to a different source page. Use --fresh or --cache-path."
            )

        state = self._new_state(source_url)
        for key in (
            "backlinks",
            "results",
            "queue",
            "host_states",
            "current_clash_node",
            "current_data_browser_index",
            "created_at",
        ):
            if key in loaded:
                state[key] = loaded[key]

        state["backlinks"] = _dedupe_cache_backlinks(state.get("backlinks"))
        state["results"] = state["results"] if isinstance(state.get("results"), dict) else {}
        state["queue"] = _dedupe_strings(state.get("queue"))
        state["host_states"] = (
            state["host_states"] if isinstance(state.get("host_states"), dict) else {}
        )
        return state


class DataBrowserPool:
    def __init__(
        self,
        playwright: Any,
        *,
        count: int,
        proxy_server: str,
        logger: Callable[[str], None],
    ) -> None:
        self.playwright = playwright
        self.count = max(1, count)
        self.proxy_server = proxy_server.strip()
        self.logger = logger
        self.current_index = 0
        self.runtime_dir = Path(__file__).resolve().parent / "runtime" / "data-browsers"
        self.contexts: dict[int, Any] = {}
        self.pages: dict[int, Any] = {}

    def __enter__(self) -> "DataBrowserPool":
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        for context in reversed(list(self.contexts.values())):
            try:
                context.close()
            except Exception:
                pass

    def current_page(self) -> Any:
        return self._ensure_browser(self.current_index)

    def rotate(self, reason: str) -> int:
        if self.count <= 1:
            self.logger(f"Data browser rotation requested but only one instance exists: {reason}")
            return self.current_index
        previous = self.current_index
        self._close_browser(previous)
        self.current_index = (self.current_index + 1) % self.count
        self.logger(
            f"Data browser rotated {previous + 1} -> {self.current_index + 1}: {reason}"
        )
        time.sleep(DATA_BROWSER_STABLE_DELAY_SECONDS)
        return self.current_index

    def _ensure_browser(self, index: int) -> Any:
        if index in self.pages:
            return self.pages[index]

        profile_dir = self.runtime_dir / f"profile-{index + 1}"
        profile_dir.mkdir(parents=True, exist_ok=True)
        context = self._launch_context(profile_dir)
        page = context.new_page()
        self.contexts[index] = context
        self.pages[index] = page
        proxy_label = self.proxy_server or "system default"
        self.logger(
            f"Started data browser {index + 1}/{self.count}: {profile_dir}; proxy={proxy_label}"
        )
        return page

    def _close_browser(self, index: int) -> None:
        context = self.contexts.pop(index, None)
        self.pages.pop(index, None)
        if context is None:
            return
        try:
            context.close()
            self.logger(f"Closed data browser {index + 1}/{self.count}.")
        except Exception as error:
            self.logger(f"WARNING: failed to close data browser {index + 1}: {error}")

    def _launch_context(self, profile_dir: Path) -> Any:
        launch_kwargs = {
            "headless": False,
            "ignore_https_errors": True,
            "args": [
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
            ],
        }
        if self.proxy_server:
            launch_kwargs["proxy"] = {"server": self.proxy_server}
        try:
            return self.playwright.chromium.launch_persistent_context(
                str(profile_dir),
                channel="chrome",
                **launch_kwargs,
            )
        except Exception as chrome_error:
            self.logger(
                "System Chrome launch failed; falling back to Playwright Chromium: "
                f"{chrome_error}"
            )
            return self.playwright.chromium.launch_persistent_context(
                str(profile_dir),
                **launch_kwargs,
            )


def autodiscover_cdp_url() -> str | None:
    candidates: list[tuple[int, str]] = []
    for port in COMMON_CDP_PORTS:
        for host in COMMON_LOOPBACK_HOSTS:
            candidate = f"http://{host}:{port}"
            metadata = _probe_cdp_endpoint(candidate)
            if not metadata:
                continue
            score = 0 if "HeadlessChrome" in metadata.get("User-Agent", "") else 10
            candidates.append((score, candidate))

    if not candidates:
        return None

    candidates.sort(reverse=True)
    return candidates[0][1]


def export_sim_backlinks(
    *,
    cdp_url: str | None,
    output_path: Path,
    clash_config: ClashConfig | None = None,
    traffic_config: TrafficRunConfig | None = None,
    logger: Callable[[str], None] = print,
) -> ExportResult:
    from playwright.sync_api import sync_playwright

    traffic_config = traffic_config or TrafficRunConfig()
    resolved_cdp_url = cdp_url or autodiscover_cdp_url()
    if not resolved_cdp_url:
        raise RuntimeError("No reachable Chrome CDP endpoint was found.")

    logger(f"Connecting to Chrome CDP: {resolved_cdp_url}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(resolved_cdp_url)
        try:
            source_context, source_page = find_source_context_and_page(browser.contexts)
            if source_page is None or source_context is None:
                raise RuntimeError("No open sim.3ue.com backlinks page was found. Open the target page first.")

            source_url = source_page.url
            logger(f"Found source page: {source_url}")
            cache_path = traffic_config.cache_path or default_cache_path(source_url)
            cache = TrafficStateCache(
                cache_path,
                source_url=source_url,
                fresh=traffic_config.fresh,
            )
            logger(f"Using cache: {cache.path}")

            work_page = source_context.new_page()
            try:
                backlinks = cache.backlink_records()
                if backlinks:
                    logger(f"Loaded {len(backlinks)} hostnames from cache.")
                    cache.set_backlinks(backlinks)
                else:
                    work_page.goto(source_url, wait_until="load", timeout=PAGE_TIMEOUT_MS)
                    backlinks = collect_backlinks(work_page, logger=logger)
                    cache.set_backlinks(backlinks)
                    logger(f"Collected {len(backlinks)} unique hostnames from sim.")

                if not traffic_config.fetch_traffic:
                    write_backlinks_csv(output_path, backlinks)
                    logger("Skipped Similarweb traffic lookup. Exported backlinks only.")
                    logger(f"Wrote CSV: {output_path}")
                    return ExportResult(
                        output_path=output_path,
                        exported_count=len(backlinks),
                        deferred_failed_count=0,
                    )

                clash_switcher = (
                    ClashNodeSwitcher(clash_config, logger=logger)
                    if clash_config and clash_config.enabled
                    else None
                )
                if not cache.state["queue"]:
                    logger("No pending traffic tasks in cache.")
                    exported_records = cache.export_records()
                    deferred_failed_count = cache.deferred_failed_count()
                else:
                    with DataBrowserPool(
                        playwright,
                        count=traffic_config.data_browser_count,
                        proxy_server=traffic_config.data_browser_proxy,
                        logger=logger,
                    ) as data_browsers:
                        data_browsers.current_index = int(
                            cache.state.get("current_data_browser_index") or 0
                        ) % data_browsers.count
                        exported_records, deferred_failed_count = collect_traffic_records(
                            cache,
                            backlinks,
                            data_browsers=data_browsers,
                            clash_switcher=clash_switcher,
                            config=traffic_config,
                            logger=logger,
                        )
            finally:
                work_page.close()

            write_csv(output_path, exported_records)
            exported_count = len(filter_export_records(exported_records))
            logger(f"Wrote CSV: {output_path}")
            return ExportResult(
                output_path=output_path,
                exported_count=exported_count,
                deferred_failed_count=deferred_failed_count,
            )
        finally:
            browser.close()


def find_source_context_and_page(contexts: list[Any]) -> tuple[Any | None, Any | None]:
    for context in contexts:
        for page in reversed(context.pages):
            if is_backlinks_page(page.url):
                return context, page
    return None, None


def collect_backlinks(page: Any, *, logger: Callable[[str], None]) -> list[BacklinkRecord]:
    unique: dict[str, BacklinkRecord] = {}
    expected_total_pages: int | None = None

    for page_guard in range(1, 501):
        snapshot = wait_for_backlinks_snapshot(page, timeout_ms=PAGE_TIMEOUT_MS)
        current_page = int(snapshot["currentPage"])
        total_pages = int(snapshot["totalPages"])

        if expected_total_pages is None:
            expected_total_pages = total_pages
            logger(f"Locked total pages: {expected_total_pages}")
        elif total_pages != expected_total_pages or current_page > expected_total_pages:
            raise RuntimeError("Backlinks pagination became inconsistent. The page structure may have changed.")

        for record in dedupe_backlink_urls(snapshot["urls"]):
            unique.setdefault(record.hostname, record)

        logger(f"Backlinks page {current_page}/{total_pages}; unique hostnames: {len(unique)}")

        if not snapshot["hasNext"] or current_page >= total_pages:
            return list(unique.values())

        delay_seconds = random.uniform(MIN_PAGE_DELAY_SECONDS, MAX_PAGE_DELAY_SECONDS)
        time.sleep(delay_seconds)

        click_next_backlinks_page(
            page,
            previous_page=current_page,
            previous_first_href=snapshot.get("firstHref"),
            logger=logger,
        )

    raise RuntimeError("Backlinks pagination exceeded 500 pages. Stopping to avoid a runaway loop.")


def click_next_backlinks_page(
    page: Any,
    *,
    previous_page: int,
    previous_first_href: str | None,
    logger: Callable[[str], None],
) -> None:
    last_click_result: dict[str, Any] | None = None
    last_error: Exception | None = None

    for attempt in range(1, PAGE_ACTION_RETRY_ATTEMPTS + 1):
        try:
            click_result = page.evaluate(CLICK_NEXT_PAGE_JS)
        except Exception as error:
            if not _is_transient_page_evaluate_error(error):
                raise

            last_error = error
            logger(
                "Backlinks next-page click hit a transient browser navigation error; "
                f"checking whether page {previous_page + 1} already loaded. "
                f"Attempt {attempt}/{PAGE_ACTION_RETRY_ATTEMPTS}."
            )
            try:
                wait_for_backlinks_advance(
                    page,
                    previous_page=previous_page,
                    previous_first_href=previous_first_href,
                    timeout_ms=PAGE_TIMEOUT_MS,
                )
                return
            except Exception as wait_error:
                if not _is_transient_page_evaluate_error(wait_error) and attempt >= PAGE_ACTION_RETRY_ATTEMPTS:
                    raise RuntimeError(
                        "Failed to recover after a transient backlinks page navigation error."
                    ) from wait_error
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

        last_click_result = click_result
        if not click_result.get("clicked"):
            time.sleep(1.5)
            continue

        wait_for_backlinks_advance(
            page,
            previous_page=previous_page,
            previous_first_href=previous_first_href,
            timeout_ms=PAGE_TIMEOUT_MS,
        )
        return

    details = (last_click_result or {}).get("diagnostics") or {}
    if last_error is not None:
        raise RuntimeError(
            "Failed to advance to the next backlinks page after transient browser errors. "
            f"Details: {json.dumps(details, ensure_ascii=False)}"
        ) from last_error
    raise RuntimeError(
        "Failed to advance to the next backlinks page. "
        f"Details: {json.dumps(details, ensure_ascii=False)}"
    )


def collect_traffic_records(
    cache: TrafficStateCache,
    backlinks: list[BacklinkRecord],
    *,
    data_browsers: DataBrowserPool,
    clash_switcher: ClashNodeSwitcher | None = None,
    config: TrafficRunConfig,
    logger: Callable[[str], None],
) -> tuple[list[ExportRecord], int]:
    backlink_by_hostname = {backlink.hostname: backlink for backlink in backlinks}
    consecutive_retryable_failures = 0

    while True:
        now = time.time()
        hostname = cache.next_ready_hostname(now)
        if hostname is None:
            wait_seconds = cache.seconds_until_next_retry(now)
            if wait_seconds is None:
                break
            if not config.wait_for_delayed_retries:
                logger(
                    "No ready hostnames. "
                    f"{cache.waiting_retry_count()} hostnames are waiting for delayed retry; "
                    "ending this run and keeping them in cache for the next run."
                )
                break
            logger(f"No ready hostnames. Sleeping {wait_seconds:.0f}s until the next retry.")
            time.sleep(wait_seconds)
            continue

        backlink = backlink_by_hostname.get(hostname)
        if backlink is None:
            logger(f"WARNING: cache queue contains unknown hostname: {hostname}")
            cache.remove_from_queue(hostname)
            cache.save()
            continue

        next_attempt = cache.attempts(hostname) + 1
        if next_attempt > config.max_traffic_attempts:
            cache.mark_deferred_failed(
                hostname,
                error_message="Reached max traffic attempts before retry.",
                count_attempt=False,
            )
            logger(f"Deferred failed {hostname}: max attempts reached.")
            continue

        logger(
            "Similarweb "
            f"{len(cache.state['results']) + 1}/{len(backlinks)}: "
            f"{hostname} attempt {next_attempt}/{config.max_traffic_attempts} "
            f"via data browser {data_browsers.current_index + 1}"
        )

        try:
            monthly_visits = fetch_monthly_visits(data_browsers.current_page(), hostname)
        except NonRetryableTrafficError as error:
            error_message = str(error)
            cache.mark_deferred_failed(hostname, error_message=error_message)
            logger(f"Deferred failed {hostname} without retry: {error_message}")
            continue
        except Exception as error:
            error_message = str(error)
            consecutive_retryable_failures += 1
            logger(f"Retryable Similarweb failure for {hostname}: {error_message}")

            if clash_switcher is not None:
                try:
                    switch_result = clash_switcher.switch_to_next_node(error_message)
                    cache.set_runtime_cursor(current_clash_node=switch_result.next_node)
                    logger(
                        "Clash switched "
                        f"{switch_result.group_name}: "
                        f"{switch_result.previous_node or 'unknown'} -> {switch_result.next_node}"
                    )
                except Exception as clash_error:
                    logger(f"WARNING: Clash switch failed: {clash_error}")

            if consecutive_retryable_failures >= config.data_failure_threshold:
                data_browsers.rotate(
                    f"{consecutive_retryable_failures} consecutive retryable failures"
                )
                cache.set_runtime_cursor(current_data_browser_index=data_browsers.current_index)
                consecutive_retryable_failures = 0

            if next_attempt >= config.max_traffic_attempts:
                cache.mark_deferred_failed(hostname, error_message=error_message)
                logger(f"Deferred failed {hostname}: {error_message}")
                continue

            retry_delay = calculate_retry_delay_seconds(
                next_attempt,
                base_delay_seconds=config.retry_base_delay_seconds,
                max_delay_seconds=config.retry_max_delay_seconds,
            )
            cache.mark_retry(
                hostname,
                error_message=error_message,
                next_retry_at=time.time() + retry_delay,
            )
            logger(f"Queued retry for {hostname} in {retry_delay}s.")
            continue

        consecutive_retryable_failures = 0
        cache.mark_success(backlink, monthly_visits)
        logger(f"Cached traffic for {hostname}: {monthly_visits}")

    return cache.export_records(), cache.deferred_failed_count()


def calculate_retry_delay_seconds(
    failed_attempt_number: int,
    *,
    base_delay_seconds: int,
    max_delay_seconds: int,
) -> int:
    safe_attempt = max(1, failed_attempt_number)
    delay = base_delay_seconds * (2 ** (safe_attempt - 1))
    return min(delay, max_delay_seconds)


def fetch_monthly_visits(page: Any, hostname: str) -> int:
    target_url = SIMILARWEB_URL_TEMPLATE.format(domain=quote(hostname, safe=""))
    response = page.goto(target_url, wait_until="load", timeout=TRAFFIC_TIMEOUT_MS)
    if response is None:
        raise RuntimeError("Similarweb request did not return a browser response.")
    if response.status == 400:
        raise NonRetryableTrafficError("Similarweb returned HTTP 400 Bad Request.")
    if response.status >= 400:
        raise RuntimeError(f"Similarweb returned HTTP {response.status}.")

    snapshot = wait_for_traffic_snapshot(page, hostname=hostname, timeout_ms=TRAFFIC_TIMEOUT_MS)
    visits = snapshot.get("visits")
    if not isinstance(visits, int):
        raise RuntimeError("Similarweb response did not contain a valid visits value.")
    return visits


def wait_for_backlinks_snapshot(page: Any, *, timeout_ms: int) -> dict[str, Any]:
    return _poll_page_value(
        page,
        GET_BACKLINKS_SNAPSHOT_JS,
        timeout_ms=timeout_ms,
        error_message="Timed out while waiting for the backlinks table to appear.",
    )


def wait_for_backlinks_advance(
    page: Any,
    *,
    previous_page: int,
    previous_first_href: str | None,
    timeout_ms: int,
) -> dict[str, Any]:
    return _poll_page_value(
        page,
        DID_BACKLINKS_PAGE_ADVANCE_JS,
        arg={"previousPage": previous_page, "previousFirstHref": previous_first_href},
        timeout_ms=timeout_ms,
        error_message="Timed out while waiting for the backlinks page to advance.",
    )


def wait_for_traffic_snapshot(page: Any, *, hostname: str, timeout_ms: int) -> dict[str, Any]:
    try:
        return _poll_page_value(
            page,
            READ_TRAFFIC_SNAPSHOT_JS,
            arg={"hostname": hostname},
            timeout_ms=timeout_ms,
            error_message="Timed out while waiting for Similarweb JSON data.",
        )
    except RuntimeError as error:
        diagnostics = page.evaluate(READ_TRAFFIC_DIAGNOSTICS_JS)
        raise RuntimeError(f"{error} Diagnostics: {json.dumps(diagnostics, ensure_ascii=False)}") from error


def is_retryable_traffic_error(error: Exception) -> bool:
    text = str(error).lower()
    retryable_fragments = (
        "http 403",
        "http 429",
        "http 5",
        "timeout",
        "timed out",
        "did not return a browser response",
        "non-json",
        "json",
        "domain",
        "diagnostics",
        "target closed",
        "execution context was destroyed",
    )
    return any(fragment in text for fragment in retryable_fragments)


def _poll_page_value(
    page: Any,
    script: str,
    *,
    arg: dict[str, Any] | None = None,
    timeout_ms: int,
    error_message: str,
) -> dict[str, Any]:
    deadline = time.time() + (timeout_ms / 1000.0)
    last_transient_error: Exception | None = None
    while time.time() < deadline:
        try:
            result = page.evaluate(script, arg) if arg is not None else page.evaluate(script)
        except Exception as error:
            if _is_transient_page_evaluate_error(error):
                last_transient_error = error
                time.sleep(POLL_INTERVAL_SECONDS)
                continue
            raise

        if result:
            return result
        time.sleep(POLL_INTERVAL_SECONDS)

    if last_transient_error is not None:
        raise RuntimeError(f"{error_message} Last transient browser error: {last_transient_error}") from last_transient_error
    raise RuntimeError(error_message)


def _is_transient_page_evaluate_error(error: Exception) -> bool:
    text = str(error)
    transient_fragments = (
        "Execution context was destroyed",
        "Cannot find context with specified id",
        "Target closed",
        "most likely because of a navigation",
    )
    return any(fragment in text for fragment in transient_fragments)


def _probe_cdp_endpoint(cdp_url: str) -> dict[str, Any] | None:
    try:
        request = Request(f"{cdp_url}/json/version", headers={"Accept": "application/json"})
        with urlopen(request, timeout=1.5) as response:
            if response.status != 200:
                return None
            payload = json.load(response)
    except Exception:
        return None

    if not payload.get("Browser"):
        return None
    return payload


def _coerce_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dedupe_strings(raw_values: Any) -> list[str]:
    if not isinstance(raw_values, list):
        return []
    values: list[str] = []
    seen: set[str] = set()
    for raw_value in raw_values:
        value = str(raw_value or "").strip().lower()
        if not value or value in seen:
            continue
        values.append(value)
        seen.add(value)
    return values


def _dedupe_cache_backlinks(raw_backlinks: Any) -> list[dict[str, str]]:
    if not isinstance(raw_backlinks, list):
        return []
    records: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in raw_backlinks:
        if not isinstance(raw, dict):
            continue
        hostname = str(raw.get("hostname") or "").strip().lower()
        source_url = str(raw.get("source_url") or "").strip()
        if not hostname or not source_url or hostname in seen:
            continue
        records.append({"hostname": hostname, "source_url": source_url})
        seen.add(hostname)
    return records
