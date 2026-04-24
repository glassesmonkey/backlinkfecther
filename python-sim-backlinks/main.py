from __future__ import annotations

import argparse
import sys
from pathlib import Path

from clash_controller import ClashConfig, DEFAULT_CLASH_API_URL, DEFAULT_CLASH_SECRET, parse_exclude_keywords
from sim_exporter import (
    DEFAULT_DATA_BROWSER_PROXY,
    TrafficRunConfig,
    default_output_path,
    export_sim_backlinks,
    format_cdp_start_hint,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export backlinks from sim.3ue.com using an existing Chrome CDP session."
    )
    parser.add_argument(
        "--cdp-url",
        help="Chrome DevTools endpoint, for example http://127.0.0.1:9223.",
    )
    parser.add_argument(
        "--output",
        help="Output CSV path. Defaults to python-sim-backlinks/output/sim-backlinks-YYYYMMDD-HHMMSS.csv.",
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="Open a small graphical UI for configuring CDP and Clash options.",
    )
    parser.add_argument(
        "--enable-clash",
        action="store_true",
        help="Switch to the next Clash node and retry when a Similarweb request fails.",
    )
    parser.add_argument(
        "--clash-url",
        default=DEFAULT_CLASH_API_URL,
        help=f"Clash external controller URL. Defaults to {DEFAULT_CLASH_API_URL}.",
    )
    parser.add_argument(
        "--clash-secret",
        default=DEFAULT_CLASH_SECRET,
        help="Clash external controller secret.",
    )
    parser.add_argument(
        "--clash-exclude-keywords",
        default="",
        help="Comma-separated keywords. Nodes containing these words will not be selected.",
    )
    parser.add_argument(
        "--data-browser-count",
        type=int,
        default=2,
        help="Number of automatically launched Chrome instances for data.similarweb.com.",
    )
    parser.add_argument(
        "--data-browser-proxy",
        default=DEFAULT_DATA_BROWSER_PROXY,
        help=f"Proxy server used by data browsers. Defaults to {DEFAULT_DATA_BROWSER_PROXY}.",
    )
    parser.add_argument(
        "--data-failure-threshold",
        type=int,
        default=3,
        help="Rotate to the next data browser after this many consecutive retryable failures.",
    )
    parser.add_argument(
        "--max-traffic-attempts",
        type=int,
        default=8,
        help="Maximum Similarweb attempts for one hostname before marking deferred_failed.",
    )
    parser.add_argument(
        "--retry-base-delay-seconds",
        type=int,
        default=60,
        help="First delayed retry wait in seconds.",
    )
    parser.add_argument(
        "--retry-max-delay-seconds",
        type=int,
        default=600,
        help="Maximum delayed retry wait in seconds.",
    )
    parser.add_argument(
        "--cache-path",
        help="State cache JSON path. Defaults to runtime/cache/<source-url-hash>.json.",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Ignore an existing cache file and restart this source page from scratch.",
    )
    parser.add_argument(
        "--wait-for-delayed-retries",
        action="store_true",
        help="Keep the process alive and sleep until delayed retries are ready.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.gui:
        from gui import run_gui

        run_gui()
        return 0

    output_path = Path(args.output).expanduser() if args.output else default_output_path()
    clash_config = ClashConfig(
        enabled=args.enable_clash,
        api_url=args.clash_url,
        secret=args.clash_secret,
        exclude_keywords=parse_exclude_keywords(args.clash_exclude_keywords),
    )
    traffic_config = TrafficRunConfig(
        data_browser_count=args.data_browser_count,
        data_failure_threshold=args.data_failure_threshold,
        max_traffic_attempts=args.max_traffic_attempts,
        retry_base_delay_seconds=args.retry_base_delay_seconds,
        retry_max_delay_seconds=args.retry_max_delay_seconds,
        data_browser_proxy=args.data_browser_proxy,
        wait_for_delayed_retries=args.wait_for_delayed_retries,
        cache_path=Path(args.cache_path).expanduser() if args.cache_path else None,
        fresh=args.fresh,
    )

    try:
        result = export_sim_backlinks(
            cdp_url=args.cdp_url,
            output_path=output_path,
            clash_config=clash_config,
            traffic_config=traffic_config,
        )
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        if "CDP" in str(error) or "Chrome" in str(error):
            print("", file=sys.stderr)
            print(format_cdp_start_hint(), file=sys.stderr)
        return 1

    print("")
    print(f"Done. Exported {result.exported_count} rows to {result.output_path}")
    if result.deferred_failed_count:
        print(f"Deferred failed {result.deferred_failed_count} hostnames after all Similarweb retries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
