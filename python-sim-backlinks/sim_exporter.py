from __future__ import annotations

import csv
import json
import random
import time
from dataclasses import dataclass
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

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

  if (snapshot.firstHref && previousFirstHref && snapshot.firstHref !== previousFirstHref) {
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
    skipped_count: int


def default_output_path() -> Path:
    base_dir = Path(__file__).resolve().parent
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return base_dir / "output" / f"sim-backlinks-{timestamp}.csv"


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


def write_csv(output_path: Path, records: list[ExportRecord]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(create_csv_text(records), encoding="utf-8")


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
    logger: Callable[[str], None] = print,
) -> ExportResult:
    from playwright.sync_api import sync_playwright

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

            work_page = source_context.new_page()
            try:
                work_page.goto(source_url, wait_until="load", timeout=PAGE_TIMEOUT_MS)
                backlinks = collect_backlinks(work_page, logger=logger)
                logger(f"Collected {len(backlinks)} unique hostnames from sim.")
                exported_records, skipped_count = collect_traffic_records(work_page, backlinks, logger=logger)
            finally:
                work_page.close()

            write_csv(output_path, exported_records)
            exported_count = len(filter_export_records(exported_records))
            logger(f"Wrote CSV: {output_path}")
            return ExportResult(
                output_path=output_path,
                exported_count=exported_count,
                skipped_count=skipped_count,
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

        click_result = page.evaluate(CLICK_NEXT_PAGE_JS)
        if not click_result.get("clicked"):
            time.sleep(1.5)
            click_result = page.evaluate(CLICK_NEXT_PAGE_JS)

        if not click_result.get("clicked"):
            details = click_result.get("diagnostics") or {}
            raise RuntimeError(
                "Failed to advance to the next backlinks page. "
                f"Details: {json.dumps(details, ensure_ascii=False)}"
            )

        wait_for_backlinks_advance(
            page,
            previous_page=current_page,
            previous_first_href=snapshot.get("firstHref"),
            timeout_ms=PAGE_TIMEOUT_MS,
        )

    raise RuntimeError("Backlinks pagination exceeded 500 pages. Stopping to avoid a runaway loop.")


def collect_traffic_records(
    page: Any,
    backlinks: list[BacklinkRecord],
    *,
    logger: Callable[[str], None],
) -> tuple[list[ExportRecord], int]:
    exported: list[ExportRecord] = []
    skipped_count = 0

    total = len(backlinks)
    for index, backlink in enumerate(backlinks, start=1):
        logger(f"Similarweb {index}/{total}: {backlink.hostname}")
        try:
            monthly_visits = fetch_monthly_visits(page, backlink.hostname)
        except Exception as error:
            skipped_count += 1
            logger(f"WARNING: skipped {backlink.hostname}: {error}")
            continue

        exported.append(
            ExportRecord(
                hostname=backlink.hostname,
                source_url=backlink.source_url,
                monthly_visits=monthly_visits,
            )
        )

    return exported, skipped_count


def fetch_monthly_visits(page: Any, hostname: str) -> int:
    target_url = SIMILARWEB_URL_TEMPLATE.format(domain=quote(hostname, safe=""))
    page.goto(target_url, wait_until="load", timeout=TRAFFIC_TIMEOUT_MS)
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


def _poll_page_value(
    page: Any,
    script: str,
    *,
    arg: dict[str, Any] | None = None,
    timeout_ms: int,
    error_message: str,
) -> dict[str, Any]:
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        result = page.evaluate(script, arg) if arg is not None else page.evaluate(script)
        if result:
            return result
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError(error_message)


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
