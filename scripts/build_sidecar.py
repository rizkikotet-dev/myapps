#!/usr/bin/env python3
"""Build server.py menjadi sidecar binary PyInstaller dan taruh di
src-tauri/binaries/valency-server-<rust-target-triple>[.exe]

Dipakai lokal maupun di GitHub Actions.
Prasyarat: pip install -r requirements.txt pyinstaller
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "src-tauri" / "binaries"
BUILD_DIR = ROOT / "build-sidecar"


def rust_target() -> str:
    out = subprocess.check_output(["rustc", "-vV"], text=True)
    m = re.search(r"^host:\s*(.+)$", out, re.M)
    if not m:
        raise RuntimeError("tidak bisa menentukan rust target triple")
    return m.group(1).strip()


def main() -> int:
    triple = rust_target()
    exe = ".exe" if sys.platform == "win32" else ""
    sep = ";" if sys.platform == "win32" else ":"

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "valency-server",
        "--distpath", str(BIN),
        "--workpath", str(BUILD_DIR / "work"),
        "--specpath", str(BUILD_DIR),
        "--clean", "-y",
        # path absolut: PyInstaller me-resolve --add-data relatif thd specpath
        "--add-data", f"{ROOT / 'index.html'}{sep}.",
        "--add-data", f"{ROOT / 'css'}{sep}css",
        "--add-data", f"{ROOT / 'js'}{sep}js",
    ]
    if sys.platform == "win32":
        cmd.append("--noconsole")
    # bundel roblox_config.json ke dalam exe (tersembunyi) jika ada di root.
    # Di CI file ini tidak ada (gitignored) — build tetap jalan tanpa OAuth config.
    cfg = ROOT / "roblox_config.json"
    if cfg.exists():
        cmd += ["--add-data", f"{cfg}{sep}."]
        print(f"[sidecar] roblox_config.json dibundel ke dalam exe")
    cmd.append("server.py")

    print("[sidecar]", " ".join(cmd))
    subprocess.check_call(cmd, cwd=ROOT)

    raw = BIN / f"valency-server{exe}"
    dest = BIN / f"valency-server-{triple}{exe}"
    shutil.move(str(raw), str(dest))
    print(f"[sidecar] ok -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
