"""Check or explicitly regenerate the M1+ acceptance traceability CSV."""

from __future__ import annotations

import argparse
from pathlib import Path

from traceability import read_csv, read_json, render_traceability


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/meta-v2/acceptance-matrix.csv"
MAP = ROOT / "tools/m1-10/traceability-map.json"
OUTPUT = ROOT / "docs/meta-v2/traceability.csv"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help="write only docs/meta-v2/traceability.csv; default is a read-only check",
    )
    args = parser.parse_args()
    expected = render_traceability(read_csv(SOURCE), read_json(MAP))
    current = OUTPUT.read_text(encoding="utf-8-sig") if OUTPUT.exists() else ""
    if args.write:
        OUTPUT.write_text(expected, encoding="utf-8", newline="")
        print(f"Wrote {OUTPUT.relative_to(ROOT)} ({expected.count(chr(10)) - 1} requirements).")
        return 0
    if current != expected:
        print("Traceability drift: run python tools/m1-10/generate_traceability.py --write")
        return 1
    print(f"Traceability current ({expected.count(chr(10)) - 1} requirements).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
