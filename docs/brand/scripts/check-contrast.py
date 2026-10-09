#!/usr/bin/env python3
"""Check the documented nullrpc sRGB color pairs; Python 3 standard library only.

Run from any directory: python3 /absolute/path/to/docs/brand/scripts/check-contrast.py
Values come from tokens/brand.json. Unrounded ratios determine pass/fail.
This checks palette pairings, not rendered pages or full WCAG conformance.
"""
from pathlib import Path
import json
import sys


def luminance(hex_color):
    """WCAG relative luminance of an opaque six-digit sRGB color."""
    channels = [int(hex_color.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return sum(c * weight for c, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def contrast(foreground, background):
    lighter, darker = sorted((luminance(foreground), luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def main():
    tokens = json.loads((Path(__file__).resolve().parents[1] / "tokens" / "brand.json").read_text())
    checks = 0
    failures = []
    for theme_name, theme in tokens["themes"].items():
        print(f"\n{theme_name.upper()}")
        pairs = [(fg, bg, 4.5) for bg in ("bg", "surface", "surface-raised")
                 for fg in ("text", "text-secondary", "accent", "status-success", "status-warning", "status-error")]
        pairs.append(("button-text", "button-bg", 4.5))
        pairs += [(fg, bg, 3.0) for bg in ("bg", "surface", "surface-raised")
                  for fg in ("border-strong", "focus", "chart-1", "chart-2", "chart-3", "chart-4")]
        for foreground, background, minimum in pairs:
            ratio = contrast(theme[foreground], theme[background])
            passed = ratio >= minimum
            checks += 1
            label = f"{foreground} on {background}"
            print(f"  {'PASS' if passed else 'FAIL'}  {label:38} {ratio:5.2f}:1  (minimum {minimum:.1f}:1)")
            if not passed:
                failures.append(f"{theme_name}: {label} = {ratio:.4f}:1 < {minimum:.1f}:1")
        # Decorative dividers are deliberately quiet; never count them as control boundaries.
        print("  Decorative border ratios (informational; not qualifying control boundaries):")
        for background in ("bg", "surface", "surface-raised"):
            ratio = contrast(theme["border"], theme[background])
            print(f"        border on {background:23} {ratio:5.2f}:1")
    print(f"\n{checks - len(failures)}/{checks} required color pairs pass.")
    print("No claim about full-page accessibility; inspect actual size, focus, labels, and placement.")
    if failures:
        print("\n" + "\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
