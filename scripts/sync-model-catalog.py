#!/usr/bin/env python3
"""Refresh the app's offline fallback from a generated product catalogue."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "catalog" / "product-catalog.v1.json",
    )
    args = parser.parse_args()
    payload = json.loads(args.source.read_text(encoding="utf-8"))
    if (
        payload.get("schema") != 1
        or not isinstance(payload.get("models"), dict)
        or not isinstance(payload.get("capabilities"), list)
    ):
        raise RuntimeError("Source is not a generated product catalogue")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Synced offline model catalogue to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
