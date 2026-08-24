/* ============================================================
   api.js — semua komunikasi ke backend server.py
   ============================================================ */
window.App = window.App || {};

App.api = (() => {
  const S = () => App.state;

  // ── generic helpers ──
  async function getJSON(path, opts = {}) {
    const r = await fetch(S().backendUrl + path, Object.assign({ cache: 'no-store' }, opts));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function postJSON(path, body) {
    const r = await fetch(S().backendUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ── backend detection ──
  async function checkBackend() {
    for (const base of App.CONFIG.getCandidates()) {
      try {
        const r = await fetch(base + '/api/health', { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        S().backendUrl = base;
        if (!j.ok) { S().backendOnline = false; return { online: false, reason: j.error }; }
        S().backendOnline = true;
        return { online: true, version: j.version };
      } catch (_) { /* next candidate */ }
    }
    S().backendOnline = false;
    return { online: false };
  }

  // ── tmp persistence ──
  const tmpList   = () => getJSON('/api/tmp/list');
  const tmpFile   = (name) => fetch(`${S().backendUrl}/api/tmp/file?filename=${encodeURIComponent(name)}`);
  const tmpClear  = () => fetch(S().backendUrl + '/api/tmp/clear', { method: 'POST' }).catch(() => {});
  const tmpDelete = (name) => postJSON('/api/tmp/delete', { filename: name }).catch(() => {});
  const tmpRename = (from, to) => postJSON('/api/tmp/rename', { from, to }).catch(() => {});
  const uploadTmp = (file) => fetch(
    `${S().backendUrl}/api/upload?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', headers: { 'X-Filename': file.name, 'Content-Type': file.type || 'application/octet-stream' }, body: file }
  ).then(r => r.ok ? console.log('synced to tmp:', file.name) : console.warn('sync tmp gagal')).catch(e => console.warn('sync tmp error', e));

  const saveAudio = (blob, filename) => fetch(
    `${S().backendUrl}/api/save?filename=${encodeURIComponent(filename)}`,
    { method: 'POST', headers: { 'X-Filename': filename }, body: blob }
  ).then(r => r.ok ? console.log('saved to audio/:', filename) : console.warn('save audio gagal')).catch(e => console.warn('save audio error', e));

  // ── yt-dlp download ──
  async function downloadFromUrl(url) {
    const resp = await fetch(S().backendUrl + '/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch (_) {}
      throw new Error(msg || ('HTTP ' + resp.status));
    }
    return resp; // caller membedakan json playlist vs binary
  }
  const fetchRelative = (u) => u.startsWith('http') ? u : S().backendUrl + u;

  // ── roblox endpoints ──
  const robloxConfig = () => getJSON('/api/roblox/config');
  const robloxMe     = () => getJSON('/api/roblox/me').catch(e => ({ logged: false, error: e.message }));
  const robloxDebug  = () => getJSON('/api/roblox/debug');
  const robloxLogin = async () => {
    const base = S().backendUrl + '/api/roblox/login';
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) { location.href = base; return; } // browser biasa: navigasi seperti biasa
    // desktop (Tauri): minta URL authorize sebagai JSON, buka di browser eksternal.
    // redirect:'manual' agar jika backend versi lama melakukan 302, kita tidak
    // mengikuti redirect sampai halaman HTML Roblox lalu gagal parse JSON.
    const r = await fetch(base + '?json=1', { cache: 'no-store', redirect: 'manual' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('application/json')) {
      throw new Error('Backend belum mendukung login browser eksternal — tutup app, matikan proses valency-server lama lewat Task Manager, lalu jalankan ulang.');
    }
    const j = await r.json();
    if (!j.url) throw new Error(j.error || 'URL login tidak diterima dari server');
    await invoke('open_external', { url: j.url });
  };
  const robloxLogout = async () => {
    try { await fetch(S().backendUrl + '/api/roblox/logout', { method: 'POST' }); } catch (_) {}
  };

  // XHR (bukan fetch) agar event upload.onprogress tersedia → progres realtime
  function robloxUpload(blob, filename, displayName, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('fileContent', blob, filename);
      fd.append('displayName', displayName);
      const qs = `?filename=${encodeURIComponent(filename)}&displayName=${encodeURIComponent(displayName)}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', S().backendUrl + '/api/roblox/upload' + qs);
      if (onProgress) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      }
      xhr.onload = () => {
        let j = {};
        try { j = JSON.parse(xhr.responseText); }
        catch (_) { j = { error: (xhr.responseText || '').slice(0, 300) }; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Koneksi ke server terputus saat upload'));
      xhr.onabort = () => reject(new Error('Upload dibatalkan'));
      xhr.send(fd);
    });
  }
  const robloxOperation = (opId) => getJSON('/api/roblox/operations/' + encodeURIComponent(opId));
  const robloxAsset     = (assetId) => getJSON('/api/roblox/asset/' + encodeURIComponent(assetId));

  return {
    checkBackend, tmpList, tmpFile, tmpClear, tmpDelete, tmpRename, uploadTmp,
    saveAudio, downloadFromUrl, fetchRelative,
    robloxConfig, robloxMe, robloxDebug, robloxLogin, robloxLogout,
    robloxUpload, robloxOperation, robloxAsset,
  };
})();
