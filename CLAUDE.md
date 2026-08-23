# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

"Hidden Audio Batch Converter" — a vanilla-JS web app that batch-converts audio files to OGG Vorbis using a sample-rate header trick ("hidden audio"): the OGG header is rewritten to store `originalSampleRate × speed`, so the file plays chipmunk-fast everywhere except Roblox Studio, where setting `Sound.PlaybackSpeed = 1/speed` restores normal pitch. Converted files can be auto-uploaded to Roblox as audio assets.

No build system, no tests, no linter. Plain `<script>` tags and a stdlib-only Python server. UI strings are Indonesian. The only npm devDependency is the Tauri CLI (see Desktop app section); `package.json` scripts: `npm run dev`/`build`/`sidecar`.

## Running

```bash
pip install -r requirements.txt   # yt-dlp only
python server.py                  # http://127.0.0.1:8000 — serves UI + API together
python server.py --port 8000 --host 127.0.0.1
```

- Opening `index.html` directly (file://) works for drag-and-drop conversion; URL import then degrades to showing a copyable `yt-dlp` command.
- Verify changes manually: serve, open the URL, confirm `GET /api/health` reports the yt-dlp version. There are no automated tests to run.
- CDN dependencies (Tabler icons, SweetAlert2, wasm-media-encoders WASM) need network; if the WASM encoder fails to load, the boot loader stays in an error state — there is no fallback encoder.

## Architecture

Two independent halves that talk over HTTP JSON:

### Frontend (`index.html` + `js/`, `css/`)

Global `window.App` namespace; one IIFE module per file under `js/`. Script order in index.html matters: `config.js` → `utils.js` → `state.js` → `api.js` → `files.js` → `urlfetch.js` → `roblox.js` → `audio.js` → `main.js` → `ui-extras.js`. Keep this order and don't introduce a bundler. (`ui-extras.js` is self-contained — no `App.*` dependency — but must load after the DOM exists.)

- `config.js` — backend URL candidates (same-origin, then `127.0.0.1:8000`/`localhost:8000`/`:55502`), Roblox OAuth scopes, poll intervals.
- `api.js` — every `fetch` call. Backend detection probes candidates against `/api/health`; the winner is stored in `App.state.backendUrl` and reused by all calls.
- `state.js` — mutable shared state (`files[]`, `backendUrl`, `actx`, preview nodes) in `App.state`; DOM refs live in `App.el`, populated once by the id map in `main.js` `collectEls()`.
- `files.js` — file list render/add/rename/remove. When the backend is online it mirrors adds to `tmp/` (`/api/upload`), renames/deletes to `/api/tmp/rename|delete`, and restores the list from `tmp/` on reload.
- `urlfetch.js` — URL import: single file streams back as binary; playlist responses return `entries[]` fetched one-by-one via `/api/file?id=`.
- `roblox.js` — login state UI, upload, and background polling of operation/moderation status.
- `audio.js` — conversion pipeline (see below) and preview.
- `main.js` — boot: DOM refs, event wiring, WASM encoder probe with fake-progress loader, 10 s backend health polling, `?roblox=` query handling after OAuth redirects.

Some entry points (`convertAll`, `togglePreview`, `fetchFromUrl`, `robloxLogin`, …) are exposed on `window` because the HTML still uses inline `onclick=` handlers.

### Backend (`server.py`)

Stdlib `http.server.ThreadingHTTPServer`; serves static files plus `/api/*` with CORS `*`. Routes are dispatched by string match inside big `do_GET`/`do_POST` methods.

- `POST /api/download {url}` — yt-dlp `bestaudio` into a tempdir; transcodes to mp3 when ffmpeg exists, otherwise prefers m4a. Single file → binary response with Content-Disposition; playlist → JSON `entries[]`, each backed by a token in the in-memory `FILE_CACHE` (expires after 10 min) pointing at files persisted to `tmp/`.
- tmp persistence: `GET /api/tmp/list|file`, `POST /api/tmp/clear|delete|rename`, `POST /api/upload`.
- `POST /api/save` — writes a blob into `audio/`.
- Roblox: PKCE OAuth flow (`/api/roblox/login`, `/callback`, `/me`, `/logout`, `/debug`) and `POST /api/roblox/upload`, which parses incoming multipart by hand (the `cgi` module is gone in Python 3.13+) and forwards to the Roblox Assets API v1. `GET /api/roblox/operations/<id>` and `/api/roblox/asset/<id>` proxy moderation polling.

Roblox auth: config precedence is env vars (`ROBLOX_CLIENT_ID`, …) over `roblox_config.json` (copy `roblox_config.example.json`). Setting `api_key` + `user_id` switches uploads to x-api-key mode, making OAuth optional. Tokens persist in `roblox_tokens.json` — real credentials; never commit or print them.

Roblox refresh tokens are single-use: `get_valid_access_token()` holds `REFRESH_LOCK` so concurrent pollers don't burn the refresh token twice. On 401/403 upload failures the handler introspects the token, checks granted `creator.ids` (empty ⇒ the user didn't select their account during OAuth consent — respond with a relogin hint), force-refreshes, and retries once.

Port coupling: with default CLI args, the server derives its port from `redirect_uri` in roblox_config.json; the frontend's candidate list includes 55502 to match. After a successful Roblox upload the server also keeps a backup copy in `audio/` even though the UI claims nothing is stored server-side.

## Conversion pipeline (load-bearing)

`audio.js` `convertOne()` per file:

1. Decode with the shared `AudioContext` (`decodeAudioData`); preview and conversion share one context, and preview requires a user gesture (autoplay policy). Stop preview before batch conversion.
2. Render gain through an `OfflineAudioContext` at the original sample rate (dB slider −20…+6 → linear `10^(db/20)`).
3. Encode OGG Vorbis via WASM `WasmMediaEncoder.createOggEncoder()` with `vbrQuality = qslider/9` (q0–q9), in chunks.
4. Header hack: in the first OggS page, rewrite the Vorbis ID sample-rate field (LE uint32 at `packetStart+12`, where `packetStart = 27 + pageSegments`) to `round(originalSr × speed)` (speed slider 0.5–4.0×, default 2.3), then zero CRC bytes 22–25 and recompute the OGG CRC32 over `pageSize = 27 + pageSegments + packetLength`.

When touching this code: zero bytes 22–25 *before* writing the new CRC, compute CRC over exactly the first page, and keep the `OggS` + `\x01vorbis` magic-byte guard. Breaking the CRC corrupts every download.

## Desktop app (Tauri v2)

The same codebase also ships as a desktop app via Tauri v2 (`src-tauri/`). Architecture: the webview loads static assets from `src-tauri/dist/` (synced copy of `index.html`, `css/`, `js/` via `scripts/sync_dist.py`, run automatically by `beforeDevCommand`/`beforeBuildCommand`) and the Rust shell spawns `server.py` compiled with PyInstaller as an external binary sidecar listening on `127.0.0.1:55502` (already in `js/config.js` backend candidates). The frontend needs no changes for desktop.

- Sidecar build: `python scripts/build_sidecar.py` (needs `pip install -r requirements.txt pyinstaller`) → writes `src-tauri/binaries/hidden-audio-server-<rust-triple>[.exe]`. Required before `tauri dev`/`tauri build`; `externalBin` in `tauri.conf.json`.
- Frozen server.py: when `sys.frozen`, `ROOT` = `_MEIPASS` (frontend bundled via `--add-data` so `/callback` redirects still serve UI) and data dirs (`tmp/`, `audio/`) resolve to the executable's folder or `HIDDEN_AUDIO_DATA_DIR` env var.
- Secret handling in desktop builds: the Tauri shell passes `HIDDEN_AUDIO_DATA_DIR` pointing at the OS app-data dir (marked hidden on Windows via `attrib +h`), so `roblox_tokens.json` is written there, not next to the exe. `scripts/build_sidecar.py` bundles `roblox_config.json` into the exe when it exists locally (skipped automatically in CI where the file is absent) — `load_roblox_config()` falls back to that bundled copy when no external file exists. Caveat: embedding hides the file but a determined user can still extract strings from the binary; there is no true client-side secrecy.
- Roblox login in the desktop app opens in the external/default browser, never the webview: `js/api.js` `robloxLogin()` detects Tauri (`window.__TAURI__`, enabled via `withGlobalTauri`), fetches `/api/roblox/login?json=1` (JSON `{url}` instead of 302), and invokes the custom Rust command `open_external` (tauri-plugin-opener, http/https guard only). `js/roblox.js` then polls `/api/roblox/me` every 3 s for ~3 min to pick up the session. In frozen mode the server's OAuth callback serves a small "login berhasil" page instead of redirecting to the full web app.
- Dev on Windows: `npm install`, `npm run sidecar` (build sidecar once), then `npm run dev`. Sidecar shutdown is two-layered: Rust kills the whole process tree with `taskkill /F /T` (PyInstaller onefile spawns a same-named child, so plain `kill` orphans it) on `ExitRequested`/`Exit`, and server.py runs a stdin-EOF watchdog (`_parent_watchdog`) that `os._exit(0)`s when the Tauri parent dies.
- CI: `.github/workflows/build.yml` builds Windows/msi+nsis, Linux/deb+AppImage, macOS arm64+x64 (separate runners — no universal binary since PyInstaller can't make fat binaries), uploads artifacts always, drafts a GitHub Release on `v*` tags.
- Never commit `src-tauri/binaries/` or `src-tauri/dist/` (gitignored); both are reproducible from source.
