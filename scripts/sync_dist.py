#!/usr/bin/env python3
"""Sinkronkan frontend (index.html, css/, js/) ke src-tauri/dist/ untuk Tauri frontendDist."""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "src-tauri" / "dist"
ITEMS = ["index.html", "login.html", "css", "js"]

def main() -> int:
    for item in ITEMS:
        src = ROOT / item
        if not src.exists():
            print(f"[sync-dist] missing: {src}", file=sys.stderr)
            return 1
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)
    for item in ITEMS:
        src = ROOT / item
        dst = DIST / item
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    print(f"[sync-dist] ok -> {DIST}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
