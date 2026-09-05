#!/usr/bin/env python3
"""
Valency Studio | Audio Converter — yt-dlp backend
- Serves index.html static
- POST /api/download  {url}  -> bestaudio via yt-dlp (YouTube, SoundCloud, +1800 sites)
- GET  /api/health    -> yt-dlp version check
- GET  /api/file?id=  -> serve cached playlist file

Usage:
  pip install yt-dlp
  python server.py            # http://localhost:8000
  python server.py --port 8000
"""
import argparse
import base64
import hashlib
import http.server
import json
import mimetypes
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).parent
FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    # PyInstaller onefile: frontend dibundel di _MEIPASS (read-only),
    # data user (tmp/audio/tokens) di folder tempat binary berada.
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    DATA_DIR = Path(os.environ.get("HIDDEN_AUDIO_DATA_DIR") or Path(sys.executable).parent)
else:
    DATA_DIR = ROOT
if FROZEN and sys.stdout is None:  # --noconsole build
    sys.stdout = open(os.devnull, "w")
    sys.stderr = open(os.devnull, "w")
TMP_DIR = DATA_DIR / "tmp"
AUDIO_DIR = DATA_DIR / "audio"
ROBLOX_CONFIG_PATH = DATA_DIR / "roblox_config.json"
ROBLOX_TOKEN_PATH = DATA_DIR / "roblox_tokens.json"
AUTH_TOKEN_PATH = DATA_DIR / "auth_tokens.json"
# config yang dibundel di dalam exe (PyInstaller --add-data) — fallback jika
# tidak ada roblox_config.json di DATA_DIR, agar end-user tidak bisa melihat file
BUNDLED_CONFIG_PATH = ROOT / "roblox_config.json"
AUTH_CONFIG_PATH = DATA_DIR / "auth_config.json"
FILE_CACHE = {}  # token -> Path
CACHE_LOCK = threading.Lock()
OAUTH_STATES = {}  # state -> {verifier, ts}
OAUTH_LOCK = threading.Lock()
REFRESH_LOCK = threading.Lock()
AUTH_LOCK = threading.Lock()  # read-modify-write auth_tokens.json (logout/refresh)
ROBLOX_TOKENS = {}  # in-memory {access_token, refresh_token, expires_at, scope, id_token, userinfo}
AUTH_TOKENS = {}  # in-memory {google, discord: {access_token, refresh_token, expires_at, scope, userinfo}}

# Discord webhook for login notifications
DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1545355365493899304/hpI_NfYDhKJdsp4g4HCiDzGAUiGqoWWVeY3Xzh8IhoP-AkTVSHKPasoiReiMpHJGXWRS"

def ensure_dirs():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

def _parent_watchdog():
    # mode desktop: keluar otomatis saat proses induk (Tauri) mati.
    # Windows: pipe stdin tertutup = EOF = parent sudah tidak ada.
    # Unix: anak PyInstaller mewarisi fd stdin sehingga EOF tak pernah
    # terpicu saat induk di-SIGKILL — deteksi via reparenting ke PID 1.
    import time
    if os.name == "nt":
        try:
            if sys.stdin is not None:
                sys.stdin.read()
        except Exception:
            pass
    else:
        while os.getppid() != 1:
            time.sleep(1)
    os._exit(0)

def unique_path(directory: Path, filename: str) -> Path:
    # sanitasi & hindari overwrite
    safe = re.sub(r'[^\w\-. ]+', '_', filename).strip() or "file"
    # hilangkan .. 
    safe = safe.replace("..", "_")
    p = directory / safe
    if not p.exists():
        return p
    stem = p.stem
    suffix = p.suffix
    i = 1
    while True:
        cand = directory / f"{stem} ({i}){suffix}"
        if not cand.exists():
            return cand
        i += 1

def yt_version():
    try:
        import yt_dlp
        return getattr(yt_dlp, "__version__", getattr(yt_dlp.version, "__version__", "unknown"))
    except Exception:
        return None

def send_json(handler, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    # CORS via end_headers()
    handler.end_headers()
    handler.wfile.write(body)

def audio_mime(path):
    ctype = mimetypes.guess_type(str(path))[0] or ""
    # force audio/* for browser decode — webm default is video/webm
    if ctype.startswith("video/"):
        ctype = ctype.replace("video/", "audio/", 1)
    if not ctype or not ctype.startswith("audio/"):
        ext = Path(path).suffix.lower()
        if ext == ".m4a": ctype = "audio/mp4"
        elif ext == ".mp3": ctype = "audio/mpeg"
        elif ext == ".opus": ctype = "audio/opus"
        elif ext == ".webm": ctype = "audio/webm"
        elif ext == ".ogg": ctype = "audio/ogg"
        elif ext == ".wav": ctype = "audio/wav"
        elif ext == ".flac": ctype = "audio/flac"
        else: ctype = "audio/mpeg"
    return ctype

def send_cors(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Filename")
    handler.send_header("Access-Control-Expose-Headers", "Content-Disposition")

def send_file_bytes(handler, data: bytes, filename: str, ctype: str):
    """Kirim satu respons file biner — dipakai /api/file, /api/tmp/file, hasil yt-dlp."""
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    handler.send_header("Access-Control-Expose-Headers", "Content-Disposition")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

# ── Roblox OAuth helpers ──────────────────────────────────────────────────
def parse_multipart(content_type: str, body: bytes):
    """Parse multipart/form-data tanpa module cgi (dihapus di Python 3.13+).
    Return list of parts: {name, filename, ctype, data}"""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError("boundary tidak ditemukan di Content-Type")
    boundary = m.group(1).encode()
    delim = b"--" + boundary
    parts = []
    # split by delimiter
    chunks = body.split(delim)
    for chunk in chunks:
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        # headers \r\n\r\n data
        sep = chunk.find(b"\r\n\r\n")
        if sep == -1:
            continue
        raw_headers = chunk[:sep].decode("utf-8", errors="replace")
        data = chunk[sep+4:]
        # data may end with \r\n before next delimiter; strip one trailing CRLF
        if data.endswith(b"\r\n"):
            data = data[:-2]
        name = None
        filename = None
        ctype = None
        for line in raw_headers.split("\r\n"):
            low = line.lower()
            if low.startswith("content-disposition:"):
                nm = re.search(r'name="([^"]*)"', line)
                fn = re.search(r'filename="([^"]*)"', line)
                name = nm.group(1) if nm else None
                filename = fn.group(1) if fn else None
            elif low.startswith("content-type:"):
                ctype = line.split(":", 1)[1].strip()
        parts.append({"name": name, "filename": filename, "ctype": ctype, "data": data})
    return parts

def _read_config_file() -> dict | None:
    # prioritas: DATA_DIR (override dev/user) > config dibundel dalam exe.
    # loop sudah menangani precedence: DATA_DIR dicek dulu, bundled hanya
    # dibaca jika DATA_DIR tidak ada / tidak valid. Jangan skip bundled —
    # itu satu-satunya sumber config saat HIDDEN_AUDIO_DATA_DIR kosong.
    for p in dict.fromkeys((ROBLOX_CONFIG_PATH, BUNDLED_CONFIG_PATH)):
        try:
            if p.exists():
                j = json.loads(p.read_text(encoding="utf-8-sig"))
                if isinstance(j, dict) and j:
                    return j
        except Exception as e:
            print(f"[roblox] config gagal dibaca ({p}): {e}", flush=True)
    return None

def load_roblox_config():
    # prioritas: env var > roblox_config.json
    cid = os.environ.get("ROBLOX_CLIENT_ID")
    csec = os.environ.get("ROBLOX_CLIENT_SECRET")
    redir = os.environ.get("ROBLOX_REDIRECT_URI")
    akey = os.environ.get("ROBLOX_API_KEY")
    auid = os.environ.get("ROBLOX_USER_ID")
    if cid and csec:
        cfg = {"client_id": cid, "client_secret": csec, "redirect_uri": redir or "http://127.0.0.1:8000/api/roblox/callback"}
        if akey: cfg["api_key"] = akey
        if auid: cfg["user_id"] = auid
        return cfg
    j = _read_config_file()
    if j and j.get("client_id") and j.get("client_secret"):
        j.setdefault("redirect_uri", "http://127.0.0.1:8000/api/roblox/callback")
        return j
    # mode API key only (tanpa OAuth) — tetap bisa upload
    if akey:
        return {"api_key": akey, "user_id": auid or "", "redirect_uri": "", "client_id": "", "client_secret": ""}
    if j and j.get("api_key"):
        j.setdefault("redirect_uri", "")
        return j
    return None

def load_auth_config():
    """Load Google/Discord OAuth config from auth_config.json."""
    try:
        if AUTH_CONFIG_PATH.exists():
            j = json.loads(AUTH_CONFIG_PATH.read_text(encoding="utf-8-sig"))
            return j if isinstance(j, dict) else None
    except Exception as e:
        print(f"[auth] config gagal dibaca ({AUTH_CONFIG_PATH}): {e}", flush=True)
    return None

def save_roblox_tokens(data: dict):
    global ROBLOX_TOKENS
    ROBLOX_TOKENS = data
    try:
        ROBLOX_TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass

def load_roblox_tokens():
    global ROBLOX_TOKENS
    if ROBLOX_TOKEN_PATH.exists():
        try:
            ROBLOX_TOKENS = json.loads(ROBLOX_TOKEN_PATH.read_text(encoding="utf-8-sig"))
        except Exception:
            ROBLOX_TOKENS = {}
    return ROBLOX_TOKENS

def save_auth_tokens(data: dict):
    global AUTH_TOKENS
    AUTH_TOKENS = data
    try:
        AUTH_TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass

def load_auth_tokens():
    global AUTH_TOKENS
    if AUTH_TOKEN_PATH.exists():
        try:
            AUTH_TOKENS = json.loads(AUTH_TOKEN_PATH.read_text(encoding="utf-8-sig"))
        except Exception:
            AUTH_TOKENS = {}
    return AUTH_TOKENS

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def gen_pkce():
    verifier = b64url(secrets.token_bytes(32))  # 43 chars
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge

def roblox_token_request(params: dict, client_id: str, client_secret: str):
    # Roblox menolak jika kirim Basic + body client_id/secret bersamaan ("Ambiguous request")
    # pakai body saja (sesuai contoh docs curl --data-urlencode client_id/client_secret)
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request("https://apis.roblox.com/oauth/v1/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def roblox_userinfo(access_token: str):
    req = urllib.request.Request("https://apis.roblox.com/oauth/v1/userinfo", headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

def roblox_introspect(access_token: str, cfg: dict):
    data = urllib.parse.urlencode({
        "token": access_token,
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    }).encode()
    req = urllib.request.Request("https://apis.roblox.com/oauth/v1/token/introspect", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def roblox_resources(access_token: str, cfg: dict):
    data = urllib.parse.urlencode({
        "token": access_token,
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    }).encode()
    req = urllib.request.Request("https://apis.roblox.com/oauth/v1/token/resources", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

# ── Google OAuth helpers ────────────────────────────────────────────────
def google_token_request(params: dict):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def google_userinfo(access_token: str):
    req = urllib.request.Request("https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

# ── Discord OAuth helpers ───────────────────────────────────────────────
def discord_token_request(params: dict):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request("https://discord.com/api/oauth2/token", data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "ValencyStudio/1.0",
        })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def discord_userinfo(access_token: str):
    req = urllib.request.Request("https://discord.com/api/users/@me",
        headers={
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "ValencyStudio/1.0",
        })
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

def send_discord_webhook_login(provider: str, userinfo: dict):
    """Send login notification to Discord webhook as embed."""
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        # Extract user details
        if provider == "google":
            username = userinfo.get("name") or userinfo.get("email") or "Unknown"
            email = userinfo.get("email") or "N/A"
            uuid = userinfo.get("sub") or userinfo.get("id") or "N/A"
        elif provider == "discord":
            username = userinfo.get("username") or userinfo.get("global_name") or "Unknown"
            email = userinfo.get("email") or "N/A"
            uuid = userinfo.get("id") or "N/A"
        else:
            username = str(userinfo.get("name") or userinfo.get("username") or "Unknown")
            email = str(userinfo.get("email") or "N/A")
            uuid = str(userinfo.get("sub") or userinfo.get("id") or "N/A")

        embed = {
            "title": "✅ Login Berhasil",
            "description": f"Pengguna baru login via **{provider.capitalize()}**",
            "color": 0x00FF00,  # Green
            "fields": [
                {"name": "👤 Nama", "value": username, "inline": True},
                {"name": "📧 Email", "value": email, "inline": True},
                {"name": "🔑 UUID", "value": f"`{uuid}`", "inline": False},
                {"name": "🔐 Tipe Login", "value": provider.capitalize(), "inline": True},
            ],
            "footer": {"text": "Valency Studio | Audio Converter"},
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        payload = json.dumps({"embeds": [embed]}).encode()
        req = urllib.request.Request(DISCORD_WEBHOOK_URL, data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "ValencyStudio/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            pass  # success
    except Exception as e:
        print(f"[webhook] Gagal kirim notifikasi: {e}", flush=True)

def force_refresh():
    """Force refresh access token sekarang (dipakai saat 403/401 dari Roblox)."""
    cfg = load_roblox_config()
    if not cfg:
        return None, "Config Roblox hilang"
    toks = load_roblox_tokens()
    if not toks.get("refresh_token"):
        return None, "Tidak ada refresh_token — login ulang"
    try:
        res = roblox_token_request({
            "grant_type": "refresh_token",
            "refresh_token": toks["refresh_token"],
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
        }, cfg["client_id"], cfg["client_secret"])
        new_toks = {
            "access_token": res["access_token"],
            "refresh_token": res.get("refresh_token", toks["refresh_token"]),
            "expires_at": time.time() + int(res.get("expires_in", 900)),
            "scope": res.get("scope", ""),
            "id_token": res.get("id_token", ""),
            "token_type": res.get("token_type", "Bearer"),
        }
        if toks.get("userinfo"):
            new_toks["userinfo"] = toks["userinfo"]
        save_roblox_tokens(new_toks)
        print(f"[roblox] force refresh OK, expires_in={res.get('expires_in')}", flush=True)
        return new_toks["access_token"], None
    except Exception as e:
        body = ""
        if isinstance(e, urllib.error.HTTPError):
            try: body = e.read().decode()
            except: pass
        return None, f"Force refresh gagal: {e} {body[:300]}"

def get_valid_access_token(force=False):
    # single-flight refresh agar refresh_token single-use tidak dipakai ganda oleh polling paralel
    with REFRESH_LOCK:
        toks = load_roblox_tokens()
        if not toks.get("access_token"):
            return None, "Belum login Roblox"
        exp = toks.get("expires_at", 0)
        need = force or (exp and time.time() > exp - 120)
        if need and toks.get("refresh_token"):
            # double-check setelah acquire lock (poll lain mungkin sudah refresh)
            fresh = load_roblox_tokens()
            if not force and fresh.get("access_token") and fresh.get("expires_at", 0) > time.time() + 120:
                return fresh["access_token"], None
            atok, err = force_refresh()
            if err:
                return None, err
            return atok, None
        return toks["access_token"], None

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # CORS for API
        if self.path.startswith("/api/"):
            send_cors(self)
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            v = yt_version()
            if v:
                send_json(self, 200, {"ok": True, "version": v})
            else:
                send_json(self, 200, {"ok": False, "error": "yt-dlp tidak terinstall. Jalankan: pip install yt-dlp", "version": None})
            return

        if path == "/api/file":
            token = (qs.get("id") or qs.get("token") or [""])[0]
            with CACHE_LOCK:
                fp = FILE_CACHE.get(token)
            if not fp or not fp.exists():
                send_json(self, 404, {"error": "File tidak ditemukan / expired. Coba fetch ulang."})
                return
            send_file_bytes(self, fp.read_bytes(), fp.name, audio_mime(fp))
            return

        # ── Roblox OAuth ──────────────────────────────────────────────
        if path == "/api/roblox/config":
            cfg = load_roblox_config()
            toks = load_roblox_tokens()
            send_json(self, 200, {
                "configured": bool(cfg),
                "client_id": (cfg["client_id"][:6] + "..." if cfg else None),
                "redirect_uri": cfg["redirect_uri"] if cfg else None,
                "has_token": bool(toks.get("access_token")),
                "userinfo": toks.get("userinfo"),
            })
            return

        if path == "/api/roblox/login":
            cfg = load_roblox_config()
            if not cfg:
                send_json(self, 500, {"error": "roblox_config.json belum dikonfigurasi. Buat file dengan client_id/client_secret dari https://create.roblox.com/dashboard/credentials"})
                return
            verifier, challenge = gen_pkce()
            state = b64url(secrets.token_bytes(16))
            nonce = b64url(secrets.token_bytes(16))
            with OAUTH_LOCK:
                OAUTH_STATES[state] = {"verifier": verifier, "ts": time.time()}
                # cleanup old >10min
                for k in list(OAUTH_STATES.keys()):
                    if time.time() - OAUTH_STATES[k]["ts"] > 600:
                        OAUTH_STATES.pop(k, None)
            scope = "openid profile asset:read asset:write"
            params = {
                "client_id": cfg["client_id"],
                "redirect_uri": cfg["redirect_uri"],
                "scope": scope,
                "response_type": "code",
                "state": state,
                "nonce": nonce,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account consent",
            }
            url = "https://apis.roblox.com/oauth/v1/authorize?" + urllib.parse.urlencode(params)
            # mode desktop (Tauri): ?json=1 → frontend buka URL di browser eksternal
            if qs.get("json", [""])[0] == "1":
                send_json(self, 200, {"ok": True, "url": url})
                return
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()
            return

        if path in ("/api/roblox/callback", "/callback"):
            err = qs.get("error", [""])[0]
            if err:
                desc = qs.get("error_description", [""])[0]
                self.send_response(302)
                self.send_header("Location", "/?roblox=error&msg=" + urllib.parse.quote(f"{err}: {desc}"))
                self.end_headers()
                return
            code = qs.get("code", [""])[0]
            state = qs.get("state", [""])[0]
            if not code or not state:
                send_json(self, 400, {"error": "Missing code/state"})
                return
            with OAUTH_LOCK:
                rec = OAUTH_STATES.pop(state, None)
            if not rec:
                send_json(self, 400, {"error": "State tidak valid / expired. Coba login lagi."})
                return
            cfg = load_roblox_config()
            if not cfg:
                send_json(self, 500, {"error": "Config hilang"})
                return
            try:
                res = roblox_token_request({
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": rec["verifier"],
                    "client_id": cfg["client_id"],
                    "client_secret": cfg["client_secret"],
                }, cfg["client_id"], cfg["client_secret"])
                toks = {
                    "access_token": res["access_token"],
                    "refresh_token": res.get("refresh_token", ""),
                    "expires_at": time.time() + int(res.get("expires_in", 900)),
                    "scope": res.get("scope", ""),
                    "id_token": res.get("id_token", ""),
                    "token_type": res.get("token_type", "Bearer"),
                }
                # fetch userinfo
                try:
                    ui = roblox_userinfo(toks["access_token"])
                    toks["userinfo"] = ui
                except Exception as e:
                    toks["userinfo"] = {"sub": res.get("sub", "?"), "error": str(e)}
                save_roblox_tokens(toks)
                # deteksi dini: asset scope di-grant tapi TIDAK ada akun yang dipilih di layar resource
                warn = ""
                if "asset" in toks.get("scope", ""):
                    try:
                        resj = roblox_resources(toks["access_token"], cfg)
                        ri = (resj.get("resource_infos") or [{}])[0]
                        creator_ids = ((ri.get("resources") or {}).get("creator") or {}).get("ids", [])
                        if not creator_ids:
                            warn = "&warn=no_creator"
                            print("[roblox] WARNING: consent selesai tapi creator.ids kosong — user belum pilih akun di layar resource. Upload akan 403.", flush=True)
                        else:
                            print(f"[roblox] resources OK creator.ids={creator_ids}", flush=True)
                    except Exception as re_:
                        print(f"[roblox] resources check gagal: {re_}", flush=True)
                if FROZEN:
                    # mode desktop: login terjadi di browser eksternal — jangan
                    # redirect ke web app penuh, cukup halaman konfirmasi kecil
                    body = ("<!doctype html><html><head><meta charset='utf-8'>"
                            "<title>Roblox</title></head>"
                            "<body style='font-family:sans-serif;background:#141414;color:#eee;"
                            "text-align:center;padding-top:18vh'>"
                            "<h2>&#10003; Login Roblox berhasil</h2>"
                            "<p style='color:#999'>Silakan kembali ke aplikasi Valency Studio | Audio Converter.</p>"
                            "</body></html>")
                    data = body.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(302)
                self.send_header("Location", "/?roblox=connected" + warn)
                self.end_headers()
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, "read") else str(e)
                send_json(self, 500, {"error": f"Token exchange gagal: {e.code} {body[:500]}"})
                return
            except Exception as e:
                send_json(self, 500, {"error": f"Callback error: {e}"})
                return

        if path == "/api/roblox/debug":
            cfg = load_roblox_config()
            toks = load_roblox_tokens()
            if not toks.get("access_token"):
                send_json(self, 200, {"has_token": False})
                return
            out = {
                "has_token": True,
                "expires_at": toks.get("expires_at"),
                "expires_in_sec": int((toks.get("expires_at") or 0) - time.time()),
                "scope_stored": toks.get("scope"),
            }
            try:
                intro = roblox_introspect(toks["access_token"], cfg)
                out["introspect"] = {k: intro.get(k) for k in ("active", "scope", "exp", "iat", "aud", "client_id")}
                if not intro.get("active"):
                    atok, err = get_valid_access_token(force=True)
                    out["force_refresh"] = "ok" if not err else err
                    if not err:
                        toks = load_roblox_tokens()
                        intro2 = roblox_introspect(atok, cfg)
                        out["introspect_after_refresh"] = {k: intro2.get(k) for k in ("active", "scope", "exp")}
            except Exception as e:
                out["introspect_error"] = str(e)
            try:
                res = roblox_resources(load_roblox_tokens()["access_token"], cfg)
                out["resources"] = res
            except Exception as e:
                out["resources_error"] = str(e)
            send_json(self, 200, out)
            return

        if path == "/api/roblox/me":
            toks = load_roblox_tokens()
            if not toks.get("access_token"):
                send_json(self, 401, {"logged": False, "error": "Belum login Roblox"})
                return
            # refresh if needed
            atok, err = get_valid_access_token()
            if err:
                send_json(self, 401, {"logged": False, "error": err})
                return
            toks = load_roblox_tokens()
            send_json(self, 200, {"logged": True, "userinfo": toks.get("userinfo"), "scope": toks.get("scope")})
            return

        if path.startswith("/api/roblox/asset/"):
            # GET /api/roblox/asset/<id> — cek status moderasi aset (Reviewing/Approved/Rejected)
            aid = path.rsplit("/", 1)[-1]
            if not aid:
                send_json(self, 400, {"error": "Missing asset id"})
                return
            cfg_a = load_roblox_config() or {}
            api_key_a = cfg_a.get("api_key")
            headers_a = {}
            if api_key_a:
                headers_a["x-api-key"] = api_key_a
            else:
                atok_a, err_a = get_valid_access_token()
                if err_a:
                    send_json(self, 401, {"error": err_a})
                    return
                headers_a["Authorization"] = f"Bearer {atok_a}"
            try:
                areq = urllib.request.Request(f"https://apis.roblox.com/assets/v1/assets/{urllib.parse.quote(aid)}",
                    headers=headers_a)
                with urllib.request.urlopen(areq, timeout=15) as ar_:
                    ajson = json.loads(ar_.read().decode())
                send_json(self, 200, ajson)
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, "read") else str(e)
                send_json(self, e.code, {"error": body[:600]})
                return
            except Exception as e:
                send_json(self, 500, {"error": str(e)})
                return

        if path.startswith("/api/roblox/operations/"):
            # GET /api/roblox/operations/<id> — proxy ke Roblox untuk polling realtime
            op_id = path.rsplit("/", 1)[-1]
            # handle query ?id= juga
            if not op_id or op_id == "operations":
                op_id = qs.get("id", [""])[0] or qs.get("operation", [""])[0]
            if not op_id:
                send_json(self, 400, {"error": "Missing operation id"})
                return
            cfg_o = load_roblox_config() or {}
            api_key_o = cfg_o.get("api_key")
            poll_headers = {}
            if api_key_o:
                poll_headers["x-api-key"] = api_key_o
            else:
                atok, err = get_valid_access_token()
                if err:
                    send_json(self, 401, {"error": err})
                    return
                poll_headers["Authorization"] = f"Bearer {atok}"
            try:
                poll_req = urllib.request.Request(f"https://apis.roblox.com/assets/v1/operations/{op_id}",
                    headers=poll_headers)
                with urllib.request.urlopen(poll_req, timeout=15) as pr:
                    poll = json.loads(pr.read().decode())
                send_json(self, 200, poll)
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, "read") else str(e)
                send_json(self, e.code, {"error": body[:800]})
                return
            except Exception as e:
                send_json(self, 500, {"error": str(e)})
                return

        if path == "/api/roblox/logout":
            # support GET for simple redirect logout
            save_roblox_tokens({})
            # try revoke if refresh_token exists? ignore errors
            self.send_response(302)
            self.send_header("Location", "/?roblox=logged_out")
            self.end_headers()
            return

        # ── Google OAuth ──────────────────────────────────────────────
        if path == "/api/auth/google/login":
            acfg = load_auth_config() or {}
            gc = acfg.get("google") or {}
            if not gc.get("client_id") or not gc.get("client_secret"):
                send_json(self, 500, {"error": "auth_config.json belum dikonfigurasi untuk Google. Buat file dengan client_id/client_secret."})
                return
            state = b64url(secrets.token_bytes(16))
            desktop = qs.get("desktop", ["0"])[0] == "1"
            with OAUTH_LOCK:
                OAUTH_STATES[state] = {"provider": "google", "ts": time.time(), "desktop": desktop}
                for k in list(OAUTH_STATES.keys()):
                    if time.time() - OAUTH_STATES[k]["ts"] > 600:
                        OAUTH_STATES.pop(k, None)
            callback_url = gc.get("callback_url") or f"http://{self.headers.get('Host', '127.0.0.1:8000')}/api/auth/callback/google"
            params = {
                "client_id": gc["client_id"],
                "redirect_uri": callback_url,
                "response_type": "code",
                "scope": "openid email profile",
                "state": state,
                "prompt": "select_account",
                "access_type": "offline",
            }
            url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
            if qs.get("json", [""])[0] == "1":
                send_json(self, 200, {"ok": True, "url": url})
                return
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()
            return

        if path == "/api/auth/callback/google":
            err = qs.get("error", [""])[0]
            if err:
                self.send_response(302)
                self.send_header("Location", "/?auth=error&provider=google&msg=" + urllib.parse.quote(err))
                self.end_headers()
                return
            code = qs.get("code", [""])[0]
            state = qs.get("state", [""])[0]
            if not code or not state:
                send_json(self, 400, {"error": "Missing code/state"})
                return
            with OAUTH_LOCK:
                rec = OAUTH_STATES.pop(state, None)
            if not rec or rec.get("provider") != "google":
                send_json(self, 400, {"error": "State tidak valid / expired. Coba login lagi."})
                return
            acfg = load_auth_config() or {}
            gc = acfg.get("google") or {}
            callback_url = gc.get("callback_url") or f"http://{self.headers.get('Host', '127.0.0.1:8000')}/api/auth/callback/google"
            try:
                res = google_token_request({
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": callback_url,
                    "client_id": gc["client_id"],
                    "client_secret": gc["client_secret"],
                })
                toks = {
                    "access_token": res["access_token"],
                    "refresh_token": res.get("refresh_token", ""),
                    "expires_at": time.time() + int(res.get("expires_in", 3600)),
                    "scope": res.get("scope", ""),
                    "token_type": res.get("token_type", "Bearer"),
                }
                try:
                    toks["userinfo"] = google_userinfo(toks["access_token"])
                except Exception as e:
                    toks["userinfo"] = {"sub": "?", "error": str(e)}
                at = load_auth_tokens()
                at["google"] = toks
                save_auth_tokens(at)
                send_discord_webhook_login("google", toks.get("userinfo", {}))
                if rec.get("desktop"):
                    body = ("<!doctype html><html><head><meta charset='utf-8'>"
                            "<title>Login Berhasil</title></head>"
                            "<body style='font-family:sans-serif;background:#141414;color:#eee;"
                            "text-align:center;padding-top:18vh'>"
                            "<h2>&#10003; Login Google berhasil</h2>"
                            "<p style='color:#999'>Kembali ke aplikasi Valency Studio.</p>"
                            "<p style='color:#666;margin-top:24px'>Tab ini bisa ditutup.</p>"
                            "</body></html>")
                    data = body.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(302)
                self.send_header("Location", "/?auth=connected&provider=google")
                self.end_headers()
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, "read") else str(e)
                send_json(self, 500, {"error": f"Token exchange gagal: {e.code} {body[:500]}"})
                return
            except Exception as e:
                send_json(self, 500, {"error": f"Callback error: {e}"})
                return

        if path == "/api/auth/google/me":
            with AUTH_LOCK:
                at = load_auth_tokens()
                gt = at.get("google") or {}
                if not gt.get("access_token"):
                    send_json(self, 401, {"logged": False, "error": "Belum login Google"})
                    return
                if gt.get("expires_at") and time.time() > gt["expires_at"] - 60:
                    if gt.get("refresh_token"):
                        acfg = load_auth_config() or {}
                        gc = acfg.get("google") or {}
                        try:
                            res = google_token_request({
                                "grant_type": "refresh_token",
                                "refresh_token": gt["refresh_token"],
                                "client_id": gc["client_id"],
                                "client_secret": gc["client_secret"],
                            })
                            gt["access_token"] = res["access_token"]
                            gt["expires_at"] = time.time() + int(res.get("expires_in", 3600))
                            save_auth_tokens(at)
                        except Exception as e:
                            send_json(self, 401, {"logged": False, "error": f"Refresh gagal: {e}"})
                            return
            send_json(self, 200, {"logged": True, "provider": "google", "userinfo": gt.get("userinfo"), "scope": gt.get("scope")})
            return

        if path == "/api/auth/google/logout":
            with AUTH_LOCK:
                at = load_auth_tokens()
                at.pop("google", None)
                save_auth_tokens(at)
            send_json(self, 200, {"ok": True, "msg": "Logged out Google"})
            return

        # ── Discord OAuth ─────────────────────────────────────────────
        if path == "/api/auth/discord/login":
            acfg = load_auth_config() or {}
            dc = acfg.get("discord") or {}
            if not dc.get("client_id") or not dc.get("client_secret"):
                send_json(self, 500, {"error": "auth_config.json belum dikonfigurasi untuk Discord. Buat file dengan client_id/client_secret."})
                return
            state = b64url(secrets.token_bytes(16))
            desktop = qs.get("desktop", ["0"])[0] == "1"
            with OAUTH_LOCK:
                OAUTH_STATES[state] = {"provider": "discord", "ts": time.time(), "desktop": desktop}
                for k in list(OAUTH_STATES.keys()):
                    if time.time() - OAUTH_STATES[k]["ts"] > 600:
                        OAUTH_STATES.pop(k, None)
            callback_url = dc.get("callback_url") or f"http://{self.headers.get('Host', '127.0.0.1:8000')}/api/auth/callback/discord"
            params = {
                "client_id": dc["client_id"],
                "redirect_uri": callback_url,
                "response_type": "code",
                "scope": "identify email",
                "state": state,
                "prompt": "consent",
            }
            url = "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(params)
            if qs.get("json", [""])[0] == "1":
                send_json(self, 200, {"ok": True, "url": url})
                return
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()
            return

        if path == "/api/auth/callback/discord":
            err = qs.get("error", [""])[0]
            if err:
                self.send_response(302)
                self.send_header("Location", "/?auth=error&provider=discord&msg=" + urllib.parse.quote(err))
                self.end_headers()
                return
            code = qs.get("code", [""])[0]
            state = qs.get("state", [""])[0]
            if not code or not state:
                send_json(self, 400, {"error": "Missing code/state"})
                return
            with OAUTH_LOCK:
                rec = OAUTH_STATES.pop(state, None)
            if not rec or rec.get("provider") != "discord":
                send_json(self, 400, {"error": "State tidak valid / expired. Coba login lagi."})
                return
            acfg = load_auth_config() or {}
            dc = acfg.get("discord") or {}
            callback_url = dc.get("callback_url") or f"http://{self.headers.get('Host', '127.0.0.1:8000')}/api/auth/callback/discord"
            try:
                res = discord_token_request({
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": callback_url,
                    "client_id": dc["client_id"],
                    "client_secret": dc["client_secret"],
                })
                toks = {
                    "access_token": res["access_token"],
                    "refresh_token": res.get("refresh_token", ""),
                    "expires_at": time.time() + int(res.get("expires_in", 604800)),
                    "scope": res.get("scope", ""),
                    "token_type": res.get("token_type", "Bearer"),
                }
                try:
                    toks["userinfo"] = discord_userinfo(toks["access_token"])
                except Exception as e:
                    toks["userinfo"] = {"id": "?", "error": str(e)}
                at = load_auth_tokens()
                at["discord"] = toks
                save_auth_tokens(at)
                send_discord_webhook_login("discord", toks.get("userinfo", {}))
                if rec.get("desktop"):
                    body = ("<!doctype html><html><head><meta charset='utf-8'>"
                            "<title>Login Berhasil</title></head>"
                            "<body style='font-family:sans-serif;background:#141414;color:#eee;"
                            "text-align:center;padding-top:18vh'>"
                            "<h2>&#10003; Login Discord berhasil</h2>"
                            "<p style='color:#999'>Kembali ke aplikasi Valency Studio.</p>"
                            "<p style='color:#666;margin-top:24px'>Tab ini bisa ditutup.</p>"
                            "</body></html>")
                    data = body.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(302)
                self.send_header("Location", "/?auth=connected&provider=discord")
                self.end_headers()
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode() if hasattr(e, "read") else str(e)
                send_json(self, 500, {"error": f"Token exchange gagal: {e.code} {body[:500]}"})
                return
            except Exception as e:
                send_json(self, 500, {"error": f"Callback error: {e}"})
                return

        if path == "/api/auth/discord/me":
            at = load_auth_tokens()
            dt = at.get("discord") or {}
            if not dt.get("access_token"):
                send_json(self, 401, {"logged": False, "error": "Belum login Discord"})
                return
            send_json(self, 200, {"logged": True, "provider": "discord", "userinfo": dt.get("userinfo"), "scope": dt.get("scope")})
            return

        if path == "/api/auth/discord/logout":
            with AUTH_LOCK:
                at = load_auth_tokens()
                at.pop("discord", None)
                save_auth_tokens(at)
            send_json(self, 200, {"ok": True, "msg": "Logged out Discord"})
            return

        if path == "/api/auth/config":
            acfg = load_auth_config() or {}
            at = load_auth_tokens()
            send_json(self, 200, {
                "google": {
                    "configured": bool((acfg.get("google") or {}).get("client_id")),
                    "has_token": bool((at.get("google") or {}).get("access_token")),
                    "userinfo": (at.get("google") or {}).get("userinfo"),
                },
                "discord": {
                    "configured": bool((acfg.get("discord") or {}).get("client_id")),
                    "has_token": bool((at.get("discord") or {}).get("access_token")),
                    "userinfo": (at.get("discord") or {}).get("userinfo"),
                },
            })
            return

        # ── tmp persistence: list & file serve for reload ───────────────
        if path == "/api/tmp/list":
            ensure_dirs()
            files = []
            for p in TMP_DIR.iterdir():
                if p.name == ".gitkeep": continue
                if p.is_file():
                    try:
                        files.append({"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime})
                    except: pass
            files.sort(key=lambda x: x["mtime"])
            send_json(self, 200, {"files": files})
            return
        if path == "/api/tmp/file":
            ensure_dirs()
            fname = (qs.get("filename") or qs.get("name") or [""])[0]
            fname = Path(fname).name  # sanitize
            if not fname:
                send_json(self, 400, {"error": "filename kosong"})
                return
            fp = TMP_DIR / fname
            if not fp.exists() or not fp.is_file():
                send_json(self, 404, {"error": "File tidak ada di tmp"})
                return
            send_file_bytes(self, fp.read_bytes(), fp.name, audio_mime(fp))
            return

        # fallback static
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # ── Roblox: POST /api/roblox/logout ──────────────────────────────
        if path == "/api/roblox/logout":
            save_roblox_tokens({})
            send_json(self, 200, {"ok": True, "msg": "Logged out"})
            return

        # ── Auth (Google/Discord): POST logout ───────────────────────────
        if path in ("/api/auth/google/logout", "/api/auth/discord/logout"):
            provider = "google" if "google" in path else "discord"
            # AUTH_LOCK: mencegah race saat dua logout paralel — tanpa ini,
            # load->pop->save yang saling menimpa bisa "menghidupkan" token lain.
            with AUTH_LOCK:
                at = load_auth_tokens()
                at.pop(provider, None)
                save_auth_tokens(at)
            send_json(self, 200, {"ok": True, "msg": f"Logged out {provider}"})
            return

        # ── Roblox: POST /api/roblox/upload  → auto upload Audio ke Roblox ──
        if path == "/api/roblox/upload":
            print(f"[roblox] upload hit from {self.client_address} ctype={self.headers.get('Content-Type','')[:80]} len={self.headers.get('Content-Length')}", flush=True)
            cfg_up = load_roblox_config() or {}
            api_key = cfg_up.get("api_key")
            use_api_key = bool(api_key)  # API key (first-party) diprioritaskan — tidak kena resource selection OAuth
            atok, err = None, None
            if not use_api_key:
                atok, err = get_valid_access_token()
                if err:
                    print(f"[roblox] no token: {err}", flush=True)
                    send_json(self, 401, {"error": f"Belum login Roblox: {err}"})
                    return
            toks = load_roblox_tokens()
            userinfo = toks.get("userinfo") or {}
            creator_id = userinfo.get("sub") or cfg_up.get("user_id")
            print(f"[roblox] auth={'api-key' if use_api_key else 'oauth'} user={userinfo.get('preferred_username')} id={creator_id}", flush=True)
            # parse incoming file & metadata
            ctype = self.headers.get("Content-Type", "")
            qs = urllib.parse.parse_qs(parsed.query)
            # defaults
            display_name = (qs.get("displayName") or [None])[0] or self.headers.get("X-Display-Name") or "Audio"
            description = (qs.get("description") or ["Uploaded via Valency Studio | Audio Converter"])[0]
            # allow override creator via query/header
            if qs.get("groupId"):
                creator = {"groupId": qs.get("groupId")[0]}
            elif qs.get("userId"):
                creator = {"userId": qs.get("userId")[0]}
            elif creator_id:
                creator = {"userId": str(creator_id)}
            elif cfg_up.get("user_id"):
                creator = {"userId": str(cfg_up["user_id"])}
            else:
                creator = {"userId": "1"}
            file_data = None
            file_name = "audio.ogg"
            file_ctype = "audio/ogg"
            try:
                if "multipart/form-data" in ctype:
                    length = int(self.headers.get("Content-Length", "0") or "0")
                    raw_body = self.rfile.read(length) if length else b""
                    parts = parse_multipart(ctype, raw_body)
                    # cari part file (punya filename)
                    file_part = None
                    for key in ("fileContent", "file", "files", "audio"):
                        cand = [p for p in parts if p.get("name") == key and p.get("filename")]
                        if cand:
                            file_part = cand[0]
                            break
                    if not file_part:
                        file_part = next((p for p in parts if p.get("filename")), None)
                    if file_part:
                        file_name = file_part.get("filename") or file_name
                        file_data = file_part.get("data") or b""
                        if file_part.get("ctype"):
                            file_ctype = file_part["ctype"]
                    # override displayName dari form field
                    dn_parts = [p for p in parts if p.get("name") == "displayName"]
                    if dn_parts:
                        try:
                            display_name = dn_parts[0]["data"].decode("utf-8", errors="replace")
                        except Exception:
                            pass
                    rq_parts = [p for p in parts if p.get("name") == "request"]
                    if rq_parts:
                        try:
                            reqj = json.loads(rq_parts[0]["data"].decode("utf-8", errors="replace"))
                            display_name = reqj.get("displayName", display_name)
                            description = reqj.get("description", description)
                            if reqj.get("creationContext", {}).get("creator"):
                                creator = reqj["creationContext"]["creator"]
                        except Exception:
                            pass
                    if not file_part:
                        send_json(self, 400, {"error": "Tidak ada fileContent di multipart"})
                        return
                else:
                    # raw binary
                    file_name = self.headers.get("X-Filename") or (qs.get("filename") or [file_name])[0]
                    display_name = self.headers.get("X-Display-Name") or display_name
                    ctype_hdr = self.headers.get("Content-Type", "")
                    if ctype_hdr and ctype_hdr.startswith("audio/"):
                        file_ctype = ctype_hdr
                    length = int(self.headers.get("Content-Length", "0") or "0")
                    file_data = self.rfile.read(length) if length else b""
                    if not file_data:
                        send_json(self, 400, {"error": "Body kosong"})
                        return
                    # infer ctype from filename
                    if file_name.lower().endswith(".mp3"): file_ctype = "audio/mpeg"
                    elif file_name.lower().endswith(".ogg"): file_ctype = "audio/ogg"
                    elif file_name.lower().endswith(".wav"): file_ctype = "audio/wav"
                    elif file_name.lower().endswith(".flac"): file_ctype = "audio/flac"
            except Exception as e:
                traceback.print_exc()
                print(f"[roblox] parse gagal: {e}", flush=True)
                send_json(self, 500, {"error": f"Gagal parse upload: {e} | {traceback.format_exc()[:800]}"})
                return
            print(f"[roblox] parsed file {file_name} {len(file_data) if file_data else 0} bytes ctype={file_ctype} display='{display_name}'", flush=True)
            if not file_data or len(file_data) < 100:
                print(f"[roblox] file too small", flush=True)
                send_json(self, 400, {"error": "File terlalu kecil / kosong"})
                return
            # validasi size 20MB, duration 7min (tidak cek duration di sini)
            if len(file_data) > 20*1024*1024:
                send_json(self, 400, {"error": "File >20MB — batas Roblox Audio"})
                return
            # siapkan request JSON untuk Roblox Assets API
            # Audio assetType harus "Audio"
            safe_display = re.sub(r'[^\w\-. ]+', ' ', display_name).strip()[:50] or "Audio"
            req_json = json.dumps({
                "assetType": "Audio",
                "displayName": safe_display,
                "description": description[:200],
                "creationContext": {"creator": creator}
            })
            # bangun multipart untuk Roblox
            boundary = "----RobloxBoundary" + secrets.token_hex(8)
            body_parts = []
            body_parts.append(f"--{boundary}\r\n".encode())
            body_parts.append(b'Content-Disposition: form-data; name="request"\r\n\r\n')
            body_parts.append(req_json.encode() + b"\r\n")
            body_parts.append(f"--{boundary}\r\n".encode())
            body_parts.append(f'Content-Disposition: form-data; name="fileContent"; filename="{file_name}"\r\n'.encode())
            body_parts.append(f"Content-Type: {file_ctype}\r\n\r\n".encode())
            body_parts.append(file_data)
            body_parts.append(f"\r\n--{boundary}--\r\n".encode())
            body = b"".join(body_parts)
            print(f"[roblox] uploading {file_name} ({file_ctype}, {len(file_data)} bytes) as '{safe_display}' creator={creator} auth={'api-key' if use_api_key else 'oauth'}", flush=True)
            def build_asset_request(token_val):
                headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
                if use_api_key:
                    headers["x-api-key"] = api_key
                else:
                    headers["Authorization"] = f"Bearer {token_val}"
                return urllib.request.Request("https://apis.roblox.com/assets/v1/assets",
                    data=body, headers=headers, method="POST")
            try:
                req = build_asset_request(atok)
                with urllib.request.urlopen(req, timeout=30) as r:
                    resp = json.loads(r.read().decode())
                print(f"[roblox] upload ok {resp.get('path')}", flush=True)
            except urllib.error.HTTPError as e:
                err_body = e.read().decode() if hasattr(e, "read") else str(e)
                print(f"[roblox] HTTPError {e.code}: {err_body[:1000]}", flush=True)
                traceback.print_exc()
                # 401 atau 403 "not authenticated" → kemungkinan access token expired → introspect + force refresh + retry sekali
                retriable = not use_api_key and (e.code == 401 or (e.code == 403 and "ot authenticated" in err_body))
                if use_api_key:
                    hint = ""
                    low = err_body.lower()
                    if "permission" in low or "authenticat" in low:
                        hint = " — Pastikan API key punya 'Assets' → Read+Write di create.roblox.com/dashboard/credentials → API Keys, dan user_id benar."
                    send_json(self, e.code, {"error": f"Roblox menolak via API key ({e.code}): {err_body[:800]}{hint}"})
                    return
                if retriable:
                    cfg_dbg = load_roblox_config()
                    intro_summary = ""
                    res_summary = ""
                    try:
                        intro = roblox_introspect(atok, cfg_dbg) if cfg_dbg else {}
                        print(f"[roblox] introspect: active={intro.get('active')} scope={intro.get('scope')} exp={intro.get('exp')} iat={intro.get('iat')}", flush=True)
                        intro_summary = f"introspect: active={intro.get('active')}, scope={intro.get('scope')}"
                        # cek resource creator yang di-grant
                        try:
                            resj = roblox_resources(atok, cfg_dbg)
                            ri = (resj.get("resource_infos") or [{}])[0]
                            creator_ids = ((ri.get("resources") or {}).get("creator") or {}).get("ids", [])
                            print(f"[roblox] resources creator.ids={creator_ids}", flush=True)
                            res_summary = f"creator granted: {creator_ids}"
                            if not creator_ids:
                                send_json(self, 403, {"error":
                                    "OAuth consent kamu TIDAK memberi akses asset ke akun (creator.ids kosong). "
                                    "Fix: klik Logout di web, lalu Login dengan Roblox lagi. Di layar izin Roblox, pastikan mencentang/memilih AKUN KAMU (atau 'All') pada langkah pilih resource untuk Asset, bukan hanya experience. Setelah itu coba konversi lagi.",
                                    "hint": "relogin", "debug": {"scope": intro.get("scope"), "creator_ids": creator_ids}})
                                return
                        except Exception as re_:
                            print(f"[roblox] resources gagal: {re_}", flush=True)
                    except Exception as ie:
                        print(f"[roblox] introspect gagal: {ie}", flush=True)
                        intro_summary = f"introspect error: {ie}"
                    atok2, err2 = get_valid_access_token(force=True)
                    if not err2:
                        try:
                            req2 = build_asset_request(atok2)
                            with urllib.request.urlopen(req2, timeout=30) as r2:
                                resp = json.loads(r2.read().decode())
                            print(f"[roblox] retry ok {resp.get('path')}", flush=True)
                            # lanjut ke bawah (operation handling) — lompat send response sukses
                            atok = atok2
                        except urllib.error.HTTPError as e2:
                            err_body2 = e2.read().decode() if hasattr(e2, "read") else str(e2)
                            print(f"[roblox] retry HTTPError {e2.code}: {err_body2[:1000]}", flush=True)
                            send_json(self, e2.code, {"error": f"Roblox upload gagal setelah refresh ({intro_summary}): {err_body2[:1200]}. Jika masih PERMISSION_DENIED: cek app scopes asset:read+asset:write di dashboard & login ulang.", "hint": "relogin"})
                            return
                    else:
                        send_json(self, e.code, {"error": f"Roblox upload gagal (auth): {err_body[:600]} | {err2} | {intro_summary}", "hint": "relogin"})
                        return
                elif e.code == 403:
                    hint = ""
                    low = err_body.lower()
                    # diagnosa resource creator juga di sini
                    res_summary = ""
                    try:
                        cfg_dbg2 = load_roblox_config()
                        resj = roblox_resources(atok, cfg_dbg2) if cfg_dbg2 else {}
                        ri = (resj.get("resource_infos") or [{}])[0]
                        creator_ids = ((ri.get("resources") or {}).get("creator") or {}).get("ids", [])
                        res_summary = f" | creator granted: {creator_ids}"
                        if not creator_ids:
                            hint = (" — OAuth consent TIDAK grant akses asset ke akun (creator.ids kosong). "
                                    "Logout → Login ulang → di layar izin Roblox pilih/centang akun kamu untuk Asset.")
                            send_json(self, e.code, {"error": f"Roblox menolak (403): {err_body[:500]}{hint}", "hint": "relogin", "creator_ids": creator_ids})
                            return
                    except Exception:
                        pass
                    if "permission" in low and ("asset" in low or "scope" in low):
                        hint = " — App OAuth belum punya scope asset:read/asset:write di dashboard. Tambahkan lalu Logout+Login ulang."
                    elif "authenticat" in low:
                        hint = " — Token invalid untuk Assets API. Logout lalu Login ulang (centang semua permission)."
                    send_json(self, e.code, {"error": f"Roblox menolak (403): {err_body[:800]}{res_summary}{hint}", "hint": "relogin" if "authenticat" in low else ""})
                    return
                else:
                    send_json(self, e.code, {"error": f"Roblox upload gagal ({e.code}): {err_body[:1200]}"})
                    return
            except Exception as e:
                traceback.print_exc()
                print(f"[roblox] exception: {e}")
                send_json(self, 500, {"error": f"Upload exception: {e} | {traceback.format_exc()[:1200]}"})
                return
            op_path = resp.get("path") or resp.get("operation") or ""
            # simpan juga ke audio/ lokal sebagai backup
            try:
                ensure_dirs()
                dest = unique_path(AUDIO_DIR, safe_display + Path(file_name).suffix)
                dest.write_bytes(file_data)
            except: pass
            if op_path.startswith("operations/"):
                op_id = op_path.split("/")[-1]
                send_json(self, 202, {"ok": True, "operation": op_path, "operationId": op_id, "pollUrl": f"/api/roblox/operations/{op_id}", "msg": "Upload diterima — polling realtime untuk status (pending/disetujui/ditolak)"})
                return
            else:
                send_json(self, 200, {"ok": True, "resp": resp, "operation": op_path})
                return

        # ── tmp persistence: clear, delete, rename ───────────────
        if path == "/api/tmp/clear":
            ensure_dirs()
            for p in TMP_DIR.iterdir():
                if p.name == ".gitkeep": continue
                try:
                    if p.is_file(): p.unlink()
                except: pass
            send_json(self, 200, {"ok": True})
            return
        if path == "/api/tmp/delete":
            ensure_dirs()
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b""
            fname = ""
            try:
                if raw:
                    j = json.loads(raw.decode())
                    fname = j.get("filename") or j.get("name") or ""
            except: pass
            if not fname:
                qs2 = urllib.parse.parse_qs(parsed.query)
                fname = (qs2.get("filename") or qs2.get("name") or [""])[0]
            fname = Path(fname).name
            if fname:
                fp = TMP_DIR / fname
                if fp.exists(): fp.unlink(missing_ok=True)
            send_json(self, 200, {"ok": True})
            return
        if path == "/api/tmp/rename":
            ensure_dirs()
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b"{}"
            try:
                j = json.loads(raw.decode() if raw else "{}")
                old = Path(j.get("from") or j.get("old") or "").name
                new = Path(j.get("to") or j.get("new") or j.get("name") or "").name
                if not old or not new:
                    raise ValueError("from/to kosong")
                src = TMP_DIR / old
                if not src.exists():
                    raise FileNotFoundError(f"{old} tidak ada di tmp")
                dst = TMP_DIR / new
                if dst.exists():
                    dst = unique_path(TMP_DIR, new)
                src.rename(dst)
                send_json(self, 200, {"ok": True, "from": old, "to": dst.name})
                return
            except Exception as e:
                send_json(self, 400, {"error": str(e)})
                return

        # ── POST /api/upload  → simpan file upload ke tmp/ ───────────────
        if path == "/api/upload":
            try:
                ensure_dirs()
                ctype = self.headers.get("Content-Type", "")
                if "multipart/form-data" in ctype:
                    length = int(self.headers.get("Content-Length", "0") or "0")
                    raw_body = self.rfile.read(length) if length else b""
                    parts = parse_multipart(ctype, raw_body)
                    saved = []
                    # semua part yang punya filename (field file/files/audio/apapun)
                    items = [p for p in parts if p.get("filename")]
                    if not items:
                        send_json(self, 400, {"error": "Tidak ada file di field 'file'"})
                        return
                    for it in items:
                        fname = it.get("filename") or "upload.bin"
                        data = it.get("data") or b""
                        dest = unique_path(TMP_DIR, fname)
                        dest.write_bytes(data)
                        saved.append({"filename": dest.name, "size": len(data), "path": f"tmp/{dest.name}"})
                    send_json(self, 200, {"ok": True, "saved": saved})
                    return
                else:
                    qs = urllib.parse.parse_qs(parsed.query)
                    fname = self.headers.get("X-Filename") or (qs.get("filename") or ["upload.bin"])[0]
                    length = int(self.headers.get("Content-Length", "0") or "0")
                    data = self.rfile.read(length) if length else b""
                    if not data:
                        send_json(self, 400, {"error": "Body kosong"})
                        return
                    dest = unique_path(TMP_DIR, fname)
                    dest.write_bytes(data)
                    send_json(self, 200, {"ok": True, "saved": [{"filename": dest.name, "size": len(data), "path": f"tmp/{dest.name}"}]})
                    return
            except Exception as e:
                send_json(self, 500, {"error": f"Upload gagal: {e}"})
                return

        # ── POST /api/save  → simpan hasil konversi ke audio/ ─────────────
        if path == "/api/save":
            ensure_dirs()
            qs = urllib.parse.parse_qs(parsed.query)
            fname = self.headers.get("X-Filename") or (qs.get("filename") or ["output.ogg"])[0]
            # jika tidak ada X-Filename, coba dari Content-Disposition?
            length = int(self.headers.get("Content-Length", "0") or "0")
            data = self.rfile.read(length) if length else b""
            if not data:
                send_json(self, 400, {"error": "Body kosong"})
                return
            # paksa .ogg jika belum
            if not Path(fname).suffix:
                fname += ".ogg"
            dest = unique_path(AUDIO_DIR, fname)
            dest.write_bytes(data)
            send_json(self, 200, {"ok": True, "saved": {"filename": dest.name, "size": len(data), "path": f"audio/{dest.name}"}})
            return

        if path != "/api/download":
            send_json(self, 404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") if raw else "{}")
        except Exception:
            send_json(self, 400, {"error": "Body JSON tidak valid"})
            return

        url = (body.get("url") or "").strip()
        if not url:
            send_json(self, 400, {"error": "Field `url` kosong"})
            return
        try:
            u = urllib.parse.urlparse(url)
            if u.scheme not in ("http", "https"):
                raise ValueError()
        except Exception:
            send_json(self, 400, {"error": "URL harus http(s)://..."})
            return

        # yt-dlp import check
        try:
            import yt_dlp
        except ImportError:
            send_json(self, 500, {"error": "yt-dlp belum terinstall. Jalankan: pip install yt-dlp"})
            return

        ensure_dirs()
        tmpdir = tempfile.mkdtemp(prefix="ytfetch_")
        try:
            outtmpl = os.path.join(tmpdir, "%(title)s.%(ext)s")
            # Prefer decode-friendly containers: m4a/mp3 > opus/webm
            # Jika ffmpeg ada, transcode ke mp3 agar pasti decodeable di browser (Safari tidak decode opus)
            has_ffmpeg = shutil.which("ffmpeg") is not None
            if has_ffmpeg:
                ydl_opts = {
                    "format": "bestaudio/best",
                    "outtmpl": outtmpl,
                    "quiet": True,
                    "no_warnings": True,
                    "noplaylist": False,
                    "extract_flat": False,
                    "retries": 2,
                    "fragment_retries": 2,
                    "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}],
                    "prefer_ffmpeg": True,
                    "keepvideo": False,
                }
            else:
                ydl_opts = {
                    "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
                    "outtmpl": outtmpl,
                    "quiet": True,
                    "no_warnings": True,
                    "noplaylist": False,
                    "extract_flat": False,
                    "prefer_free_formats": False,
                    "retries": 2,
                    "fragment_retries": 2,
                }
            # optional: restrict playlist size to avoid abuse
            max_playlist = 20

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # First probe to detect playlist size without downloading everything?
                # We just download directly; yt-dlp handles it.
                info = ydl.extract_info(url, download=True)

            # collect downloaded files
            files = []
            for root, _, names in os.walk(tmpdir):
                for n in names:
                    files.append(Path(root) / n)
            files = sorted(files, key=lambda p: p.stat().st_mtime)

            if not files:
                # maybe extractor returned playlist without downloading? try entries
                send_json(self, 500, {"error": "Tidak ada file terunduh. URL mungkin private / age-restricted / geo-block."})
                return

            if len(files) == 1:
                fp = files[0]
                # sanitize filename for header
                safe_name = re.sub(r'[^\w\-. ]+', '_', fp.name).strip() or "audio.m4a"
                send_file_bytes(self, fp.read_bytes(), safe_name, audio_mime(fp))
                return
            else:
                # playlist: cap & cache + persist to tmp/
                if len(files) > max_playlist:
                    files = files[:max_playlist]
                entries = []
                for fp in files:
                    token = os.urandom(8).hex()
                    # persist ke tmp/ agar ada di folder tmp (bukan hanya temp)
                    persist = unique_path(TMP_DIR, fp.name)
                    try:
                        shutil.copy2(fp, persist)
                    except Exception:
                        persist = fp
                    # juga cache untuk /api/file (point ke file di tmp/)
                    with CACHE_LOCK:
                        FILE_CACHE[token] = persist
                    # auto-expire cache entry after 10 min (file tetap di tmp/)
                    def expire(t=token):
                        time.sleep(600)
                        with CACHE_LOCK:
                            FILE_CACHE.pop(t, None)
                    threading.Thread(target=expire, daemon=True).start()
                    entries.append({
                        "title": fp.stem,
                        "ext": fp.suffix.lstrip("."),
                        "size": fp.stat().st_size,
                        "download_url": f"/api/file?id={token}",
                        "filename": fp.name,
                    })
                send_json(self, 200, {"ok": True, "playlist": True, "count": len(entries), "entries": entries,
                                      "note": f"Playlist terdeteksi ({len(files)} file). Semua source disimpan di tmp/, frontend akan fetch satu per satu."})
                return

        except yt_dlp.utils.DownloadError as e:
            msg = str(e)
            # shorten noisy trace
            if len(msg) > 800:
                msg = msg[:800] + "..."
            send_json(self, 500, {"error": f"yt-dlp gagal: {msg}"})
            return
        except Exception as e:
            send_json(self, 500, {"error": f"Internal error: {e}"})
            return
        finally:
            # cleanup tmpdir (playlist files already copied to persist)
            try:
                shutil.rmtree(tmpdir, ignore_errors=True)
            except:
                pass


class QuietHTTPServer(http.server.ThreadingHTTPServer):
    # Klien (webview) bisa abort koneksi saat respons sedang dikirim;
    # default handle_error mem-print traceback untuk error yang wajar ini.
    def handle_error(self, request, client_address):
        exc = sys.exception()
        if isinstance(
            exc,
            (
                ConnectionAbortedError,
                ConnectionResetError,
                BrokenPipeError,
                TimeoutError,
            ),
        ):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    # ensure index.html exists (bundled via PyInstaller --add-data saat frozen)
    if not FROZEN and not (ROOT / "index.html").exists():
        print("index.html tidak ditemukan di", ROOT)
        return 1

    ensure_dirs()
    load_roblox_tokens()
    load_auth_tokens()
    if FROZEN:
        threading.Thread(target=_parent_watchdog, daemon=True).start()
    # auto-port dari redirect_uri jika user tidak override --port
    _cfg0 = load_roblox_config()
    if _cfg0 and args.port == 8000 and args.host == "127.0.0.1":
        try:
            from urllib.parse import urlparse as _up
            _pu = _up(_cfg0.get("redirect_uri",""))
            if _pu.port and _pu.port != 8000:
                args.port = _pu.port
                print(f"[roblox] auto port -> {args.port} dari redirect_uri {_cfg0['redirect_uri']}")
            if _pu.hostname and _pu.hostname != args.host:
                # tetap bind 127.0.0.1 agar localhost tetap work
                pass
        except: pass
    v = yt_version()
    if v:
        print(f"[yt-dlp] {v} terdeteksi")
    else:
        print("[yt-dlp] BELUM terinstall — API /api/download akan error.")
        print("         Install: pip install yt-dlp  atau  pip install -r requirements.txt")
    cfg = load_roblox_config()
    if cfg:
        print(f"[roblox] OAuth configured — client_id {cfg['client_id'][:8]}... redirect {cfg['redirect_uri']}")
        if ROBLOX_TOKENS.get("userinfo"):
            print(f"[roblox] logged as {ROBLOX_TOKENS['userinfo'].get('preferred_username')} (ID {ROBLOX_TOKENS['userinfo'].get('sub')})")
        if cfg["redirect_uri"] not in ("http://127.0.0.1:8000/api/roblox/callback", "http://localhost:8000/api/roblox/callback", "http://localhost:55502/callback", "http://127.0.0.1:55502/callback"):
            print(f"[roblox] NOTE: redirect_uri custom — pastikan di dashboard Roblox persis sama!")
    else:
        print("[roblox] OAuth belum dikonfigurasi — buat roblox_config.json (lihat roblox_config.example.json)")
    acfg = load_auth_config()
    if acfg:
        for prov in ("google", "discord"):
            pc = acfg.get(prov) or {}
            if pc.get("client_id"):
                print(f"[auth:{prov}] OAuth configured — client_id {pc['client_id'][:8]}... redirect {pc.get('callback_url')}")
            else:
                print(f"[auth:{prov}] belum dikonfigurasi di auth_config.json")
    else:
        print("[auth] Google/Discord OAuth belum dikonfigurasi — buat auth_config.json")
    print(f"[dirs] tmp: {TMP_DIR}  audio: {AUDIO_DIR}")

    addr = (args.host, args.port)
    print(f"Serving {ROOT} at http://{args.host}:{args.port}/")
    print("Endpoints: GET /api/health , POST /api/download {url} , POST /api/upload , POST /api/save")
    print("  - upload/youtube source -> tmp/   |   hasil konversi -> audio/")
    print("Tekan Ctrl+C untuk stop.")
    httpd = QuietHTTPServer(addr, Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStop.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
