#!/usr/bin/env python3
"""Dev server untuk `npm run dev` (tauri dev).

- Menyajikan frontend LANGSUNG dari working tree (bukan src-tauri/dist),
  jadi yang diedit = yang terlihat.
- Live-reload via SSE (/__lr): simpan file di index.html/css/js ->
  semua klien webview otomatis location.reload().
- Stdlib saja. Dijalankan sebagai beforeDevCommand; tauri menunggu
  devUrl (lihat tauri.conf.json build.devUrl) sampai server ini naik.

Standalone (tanpa tauri, mis. cek cepat di browser biasa):
  python scripts/dev_server.py --port 1430
"""
import argparse
import mimetypes
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INJECT = (
    '<script>(function(){var e=new EventSource("/__lr");'
    "e.onmessage=function(m){if(m.data==='reload')location.reload();};"
    "})()</script>"
)

_gen = 0
_lock = threading.Lock()

# Windows registry kerap salah map .js -> text/plain
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("image/svg+xml", ".svg")


def watch_files():
    files = [ROOT / "index.html"]
    for d in ("css", "js"):
        p = ROOT / d
        if p.is_dir():
            files.extend(sorted(p.iterdir()))
    return files


def snapshot():
    sig = []
    for f in watch_files():
        try:
            sig.append((f.name, f.stat().st_mtime_ns))
        except OSError:
            sig.append((f.name, 0))
    return sig


def watch(interval=0.3):
    # ponytail: polling mtime cukup utk puluhan file; naikkan ke
    # watchdog/watchman bila file frontend ribuan atau butuh <100ms latency.
    global _gen
    last = None
    while True:
        try:
            s = snapshot()
            if last is None:
                last = s
            elif s != last:
                last = s
                with _lock:
                    _gen += 1
                print(f"[dev-server] change detected -> gen {_gen}", flush=True)
        except Exception as e:
            print(f"[dev-server] watcher error: {e!r}")
        time.sleep(interval)


class QuietHTTPServer(ThreadingHTTPServer):
    # Klien webview sering abort koneksi di tengah request (mis. reload
    # memutus SSE). Default handle_error mem-print traceback penuh utk
    # error yang memang wajar ini -> hanya laporkan error tak terduga.
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__lr":
            return self.sse()
        if path == "/" or path.endswith(".html"):
            fp = ROOT / "index.html" if path == "/" else (ROOT / path.lstrip("/"))
            try:
                fp = fp.resolve()
                fp.relative_to(ROOT)
            except (ValueError, OSError):
                return self.send_error(403)
            if fp.is_file():
                return self.serve_html(fp)
        return super().do_GET()

    def serve_html(self, fp):
        try:
            body = fp.read_bytes()
        except OSError:
            return self.send_error(404)
        inj = INJECT.encode()
        body = body.replace(b"</body>", inj + b"</body>", 1) if b"</body>" in body else body + inj
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def sse(self):
        global _gen
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            print(f"[dev-server] sse client connected", flush=True)
        except OSError:
            return
        last = -1
        beat = time.time()
        try:
            while True:
                with _lock:
                    g = _gen
                if last >= 0 and g != last:
                    self.wfile.write(b"data: reload\n\n")
                    self.wfile.flush()
                    print("[dev-server] reload sent", flush=True)
                    beat = time.time()
                last = g
                if time.time() - beat >= 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    beat = time.time()
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=1430)
    args = ap.parse_args()

    threading.Thread(target=watch, daemon=True).start()
    srv = QuietHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[dev-server] http://127.0.0.1:{args.port}  (root={ROOT})")
    print("[dev-server] live-reload aktif: index.html, css/, js/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
