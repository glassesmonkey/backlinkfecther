from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sim_exporter import default_output_path, export_sim_backlinks, format_cdp_start_hint


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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_path = Path(args.output).expanduser() if args.output else default_output_path()

    try:
        result = export_sim_backlinks(cdp_url=args.cdp_url, output_path=output_path)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        if "CDP" in str(error) or "Chrome" in str(error):
            print("", file=sys.stderr)
            print(format_cdp_start_hint(), file=sys.stderr)
        return 1

    print("")
    print(f"Done. Exported {result.exported_count} rows to {result.output_path}")
    if result.skipped_count:
        print(f"Skipped {result.skipped_count} hostnames because Similarweb data could not be read.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
