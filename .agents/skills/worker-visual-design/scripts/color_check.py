#!/usr/bin/env python3
"""sRGB contrast checks for declared solid foreground/background pairs.

This is NOT an image analysis, WCAG conformance certification, visual aesthetic
scoring, or a touch target/accessibility audit. Only declared pairs are tested.
Python 3.10+; no third-party dependencies.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
THRESHOLDS = {"text": 4.5, "large_text": 3.0, "non_text": 3.0}

class PaletteError(ValueError):
    pass

def rgb(hex_color: str) -> tuple[int, int, int]:
    if not isinstance(hex_color, str) or not HEX.fullmatch(hex_color):
        raise PaletteError(f"Expected #RRGGBB; received {hex_color!r}")
    return tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))

def linear_channel(channel: int) -> float:
    s = channel / 255.0
    return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

def luminance(color: str) -> float:
    r, g, b = rgb(color)
    return sum(w * linear_channel(v) for w, v in zip((0.2126, 0.7152, 0.0722), (r, g, b)))

def contrast(foreground: str, background: str) -> float:
    a, b = luminance(foreground), luminance(background)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)

def validate_pair(pair: object, index: int) -> dict:
    if not isinstance(pair, dict):
        raise PaletteError(f"Pair #{index} must be an object")
    name, foreground, background, kind = (pair.get(k) for k in ("name", "foreground", "background", "kind"))
    if not isinstance(name, str) or not name.strip():
        raise PaletteError(f"Pair #{index}: missing nonblank name")
    if kind not in THRESHOLDS:
        raise PaletteError(f"{name}: kind must be one of {', '.join(THRESHOLDS)}")
    value = contrast(foreground, background)
    threshold = THRESHOLDS[kind]
    return {"name": name, "kind": kind, "foreground": foreground, "background": background,
            "ratio": round(value, 4), "threshold": threshold, "passes_declared_threshold": value >= threshold}

def check_palette(path: Path) -> dict:
    try: data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc: raise PaletteError(str(exc)) from exc
    if not isinstance(data, dict): raise PaletteError("Palette root must be a JSON object")
    pairs = data.get("readability_pairs")
    if not isinstance(pairs, list) or len(pairs) == 0:
        raise PaletteError("readability_pairs must be a nonempty array of explicit solid-color pairs")
    results = [validate_pair(pair, i + 1) for i, pair in enumerate(pairs)]
    names = [p["name"] for p in results]
    if len(set(names)) != len(names): raise PaletteError("readability_pairs names must be unique")
    return {"scope": "DECLARED_SOLID_COLORS_ONLY_NOT_RENDERED_IMAGE_OR_PLATFORM_CONFORMANCE",
            "file": str(path), "count": len(results),
            "passed": sum(r["passes_declared_threshold"] for r in results),
            "failed": sum(not r["passes_declared_threshold"] for r in results),
            "results": results}

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pair = sub.add_parser("pair", help="check a single pair")
    pair.add_argument("--fg", required=True)
    pair.add_argument("--bg", required=True)
    pair.add_argument("--kind", choices=list(THRESHOLDS), default="text")
    ch = sub.add_parser("check", help="check only declared palette pairs")
    ch.add_argument("--palette", required=True, type=Path)
    ch.add_argument("--json", action="store_true", help="machine-readable result")
    args = parser.parse_args(argv)
    try:
        if args.command == "pair":
            val = contrast(args.fg, args.bg)
            ok = val >= THRESHOLDS[args.kind]
            print(f"{val:.4f}:1 threshold={THRESHOLDS[args.kind]:.1f}:1 kind={args.kind} {'PASS' if ok else 'FAIL'}")
            return 0 if ok else 1
        result = check_palette(args.palette)
        if args.json: print(json.dumps(result, ensure_ascii=True, indent=2))
        else:
            print(f"Declared solid pairs: {result['passed']}/{result['count']} pass (NOT artwork or device validation)")
            for x in result["results"]:
                print(f" {'PASS' if x['passes_declared_threshold'] else 'FAIL'} {x['ratio']:.2f}:1 >= {x['threshold']:.1f}:1 {x['kind']} {x['name']} ({x['foreground']} / {x['background']})")
        return 1 if result["failed"] else 0
    except PaletteError as exc:
        print(f"Invalid input: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
