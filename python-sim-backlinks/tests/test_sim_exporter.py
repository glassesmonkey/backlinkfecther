from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sim_exporter import ExportRecord, create_csv_text, dedupe_backlink_urls, parse_monthly_visits


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


if __name__ == "__main__":
    unittest.main()
