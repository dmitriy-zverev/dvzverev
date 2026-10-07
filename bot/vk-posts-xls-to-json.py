#!/usr/bin/env python3
"""Convert VK classic .xls (CDFv2) posts_* exports to vk-stats-v1 JSON.

Usage:
  uvx --from xlrd python bot/vk-posts-xls-to-json.py path/to/{group}_posts_content_{from}_{to}.xls

Only posts_content is per-post. audience/common are group-level and exit non-zero.
Does NOT invent post_id — output rows have empty post_id; fill wall_url later.
No Docker / runtime dependency: run offline via uvx before cabinet upload.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import xlrd
except ImportError:
    print("Need xlrd. Run: uvx --from xlrd python bot/vk-posts-xls-to-json.py <file.xls>", file=sys.stderr)
    sys.exit(2)

FILENAME_RE = re.compile(
    r"^(\d+)_posts_(audience|common|content)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.xls$",
    re.IGNORECASE,
)

CONTENT_HEADERS = [
    "Раздел",
    "Подраздел",
    "Дата",
    "Время",
    "Описание",
    "Охват",
    "Просмотры",
    "Лайки",
    "Комментарии",
    "Поделились",
    "Закладки",
]

MSK = timezone(timedelta(hours=3))


def parse_filename(path: Path) -> dict:
    match = FILENAME_RE.match(path.name)
    if not match:
        raise SystemExit(
            f"Unexpected filename: {path.name}. Expected "
            "{groupId}_posts_{audience|common|content}_{YYYY-MM-DD}_{YYYY-MM-DD}.xls"
        )
    return {
        "group_id": match.group(1),
        "kind": match.group(2).lower(),
        "period_from": match.group(3),
        "period_to": match.group(4),
    }


def moscow_day_bounds(ymd: str, end: bool = False) -> str:
    year, month, day = (int(x) for x in ymd.split("-"))
    if end:
        local = datetime(year, month, day, 23, 59, 59, tzinfo=MSK)
    else:
        local = datetime(year, month, day, 0, 0, 0, tzinfo=MSK)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def dmy_hm_to_iso(date_text: str, time_text: str) -> str | None:
    date_text = str(date_text).strip()
    time_text = (str(time_text).strip() or "00:00").replace("#", "00:00")
    try:
        day, month, year = (int(x) for x in date_text.split("."))
        parts = time_text.split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
        second = int(parts[2]) if len(parts) > 2 else 0
    except (ValueError, IndexError):
        return None
    local = datetime(year, month, day, hour, minute, second, tzinfo=MSK)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def cell_str(value) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return str(value)
    text = str(value).replace("\xa0", " ").strip()
    if text in {"", "#", "нет данных"}:
        return ""
    return text


def convert_content(sheet, meta: dict) -> dict:
    headers = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    if headers[: len(CONTENT_HEADERS)] != CONTENT_HEADERS:
        raise SystemExit(f"Unexpected posts_content headers: {headers}")

    period_from = moscow_day_bounds(meta["period_from"], end=False)
    period_to = moscow_day_bounds(meta["period_to"], end=True)
    records = []
    for r in range(1, sheet.nrows):
        row = {headers[c]: sheet.cell_value(r, c) for c in range(sheet.ncols)}
        published = dmy_hm_to_iso(row.get("Дата", ""), row.get("Время", ""))
        text = cell_str(row.get("Описание"))
        if len(text) > 240:
            text = text[:237] + "..."
        records.append(
            {
                "group_id": meta["group_id"],
                "post_id": "",
                "published_at": published or "",
                "observed_at": period_to,
                "period_from": period_from,
                "period_to": period_to,
                "metric_mode": "period",
                "views": cell_str(row.get("Просмотры")),
                "reach_total": cell_str(row.get("Охват")),
                "likes": cell_str(row.get("Лайки")),
                "comments": cell_str(row.get("Комментарии")),
                "reposts": cell_str(row.get("Поделились")),
                "saves": cell_str(row.get("Закладки")),
                "text_hint": text or None,
            }
        )

    return {
        "schemaVersion": "vk-stats-v1",
        "sourceFormat": "vk_posts_content_xls",
        "groupId": meta["group_id"],
        "periodFrom": period_from,
        "periodTo": period_to,
        "records": records,
        "notes": [
            "post_id absent in VK posts_content export — do not invent; add wall_url/post_id before commit",
            "metric_mode=period for filename date range",
            "negative counters must be fixed or rows rejected by cabinet parser",
        ],
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[1]).expanduser().resolve()
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 1
    meta = parse_filename(path)
    if meta["kind"] == "audience":
        print(
            "posts_audience is group-level demographics (devices/gender/age/cities), not per-post. Skip.",
            file=sys.stderr,
        )
        return 1
    if meta["kind"] == "common":
        print(
            "posts_common is group-level hourly/daily reach & interactions, not per-post. Skip.",
            file=sys.stderr,
        )
        return 1

    book = xlrd.open_workbook(str(path), formatting_info=False)
    sheet = book.sheet_by_index(0)
    doc = convert_content(sheet, meta)
    out_path = path.with_suffix(".vk-stats.json")
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} ({len(doc['records'])} rows). post_id empty — fill before commit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
