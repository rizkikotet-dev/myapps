/* ============================================================
   config.js — constants & environment
   ============================================================ */
window.App = window.App || {};

App.CONFIG = {
  // Backend candidates — URUSAN WAJIB SAMA dengan gate inline di index.html
  // dan BACKEND_CANDIDATES di login.html: 55501 (server.py dev, data repo)
  // sebelum 55502 (sidecar Tauri, data appdata). Kalau urutannya beda, gate
  // bisa membaca token dari server lain daripada yang dipakai runtime
  // (logout di 55502, gate baca 55501 → logout terasa tidak berfungsi).
  getCandidates() {
    const local = ['http://127.0.0.1:55501', 'http://localhost:55501', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://127.0.0.1:55502', 'http://localhost:55502'];
    const same = '';
    if (location.protocol === 'file:') return [...local, same];
    return [same, ...local];
  },
  ROBLOX_SCOPES: 'openid profile asset:read asset:write',
  AUDIO_MAX_BYTES: 20 * 1024 * 1024,
  POLL_OP_INTERVAL_MS: 3000,
  POLL_OP_MAX_TRIES: 20,
  AUDIT_INTERVAL_MS: 10000,
  AUDIT_MAX_TRIES: 30,
  ABOUT: {
    title: 'Valency Studio | Audio Converter',
    developer: 'RizkiValency',
    links: {
      github: 'https://github.com/valency-studio',
      discord: 'https://discord.gg/WR5DytXHd',
      donate: 'https://saweria.co/rizkikotet',
    },
  },
};
