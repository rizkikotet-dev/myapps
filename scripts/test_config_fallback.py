#!/usr/bin/env python3
"""Self-check _read_config_file: fallback bundel + prioritas DATA_DIR.
Jalankan: python scripts/test_config_fallback.py"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def main() -> int:
    t_data = Path(tempfile.mkdtemp())
    t_bundled = Path(tempfile.mkdtemp())
    orig = (server.ROBLOX_CONFIG_PATH, server.BUNDLED_CONFIG_PATH,
            server.AUTH_CONFIG_PATH, server.BUNDLED_AUTH_CONFIG_PATH)
    server.ROBLOX_CONFIG_PATH = t_data / "roblox_config.json"
    server.BUNDLED_CONFIG_PATH = t_bundled / "roblox_config.json"
    server.AUTH_CONFIG_PATH = t_data / "auth_config.json"
    server.BUNDLED_AUTH_CONFIG_PATH = t_bundled / "auth_config.json"
    try:
        # 1) hanya bundled -> harus terbaca (bug lama: selalu di-skip)
        server.BUNDLED_CONFIG_PATH.write_text(
            json.dumps({"client_id": "abc", "client_secret": "xyz"}), encoding="utf-8"
        )
        assert server._read_config_file().get("client_id") == "abc", "fallback bundel gagal"
        # 2) keduanya ada -> DATA_DIR menang
        server.ROBLOX_CONFIG_PATH.write_text(
            json.dumps({"client_id": "datadir", "client_secret": "x"}), encoding="utf-8"
        )
        server.BUNDLED_CONFIG_PATH.write_text(
            json.dumps({"client_id": "bundled", "client_secret": "x"}), encoding="utf-8"
        )
        assert server._read_config_file().get("client_id") == "datadir", "prioritas DATA_DIR salah"
        # 3) load_auth_config: hanya bundled -> fallback exe harus terbaca
        #    (bug build produksi: login Discord gagal karena file tak dibundel/dibaca)
        server.BUNDLED_AUTH_CONFIG_PATH.write_text(
            json.dumps({"discord": {"client_id": "dc-bundled", "client_secret": "s"}}),
            encoding="utf-8",
        )
        assert (server.load_auth_config() or {}).get("discord", {}).get("client_id") == "dc-bundled", \
            "fallback bundel auth gagal"
        # 4) load_auth_config: keduanya ada -> DATA_DIR menang
        server.AUTH_CONFIG_PATH.write_text(
            json.dumps({"discord": {"client_id": "dc-datadir", "client_secret": "s"}}),
            encoding="utf-8",
        )
        server.BUNDLED_AUTH_CONFIG_PATH.write_text(
            json.dumps({"discord": {"client_id": "dc-bundled", "client_secret": "s"}}),
            encoding="utf-8",
        )
        assert (server.load_auth_config() or {}).get("discord", {}).get("client_id") == "dc-datadir", \
            "prioritas DATA_DIR auth salah"
        print("OK: fallback bundel + prioritas DATA_DIR benar (roblox & auth)")
        return 0
    finally:
        (server.ROBLOX_CONFIG_PATH, server.BUNDLED_CONFIG_PATH,
         server.AUTH_CONFIG_PATH, server.BUNDLED_AUTH_CONFIG_PATH) = orig


if __name__ == "__main__":
    raise SystemExit(main())
