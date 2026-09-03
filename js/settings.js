/* ============================================================
   settings.js — preferensi aplikasi (Fase 3)
   Disimpan di localStorage['vs_settings_v1']. Modul ini sengaja
   dimuat SEBELUM main.js: handler DOMContentLoaded-nya terdaftar
   lebih dulu, jadi default slider/checkbox sudah terpasang saat
   main.js init() membaca nilainya. Perubahan langsung disimpan
   & diterapkan ke sesi berjalan (slider = sumber kebenaran).
   Kontrak CSS: .set-* di app.css.
   ============================================================ */
window.App = window.App || {};

App.settings = (() => {
  const KEY = 'vs_settings_v1';

  const DEFAULTS = {
    conv: { speed: 2.3, q: 9, db: -4 },
    autoUpload: true,
    autoUpdateCheck: true,   // desktop: cek update sekali saat boot
    historyEnabled: true,    // catat konversi/upload ke riwayat
  };

  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        conv: { ...DEFAULTS.conv, ...(j.conv || {}) },
        autoUpload: j.autoUpload !== false,
        autoUpdateCheck: j.autoUpdateCheck !== false,
        historyEnabled: j.historyEnabled !== false,
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  let st = load();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (_) {}
  }
  function get() { return st; }

  function reset() {
    st = JSON.parse(JSON.stringify(DEFAULTS));
    save();
    applyToSession();
    syncView();
  }

  // ── terapkan ke sesi berjalan (slider & checkbox = sumber kebenaran) ──
  function applyToSession() {
    const spd = document.getElementById('spd');
    const dbs = document.getElementById('dbs');
    const qslider = document.getElementById('qslider');
    const auto = document.getElementById('auto-upload-check');
    if (spd) { spd.value = st.conv.speed; spd.dispatchEvent(new Event('input')); }
    if (dbs) { dbs.value = st.conv.db; dbs.dispatchEvent(new Event('input')); }
    if (qslider) { qslider.value = st.conv.q; qslider.dispatchEvent(new Event('input')); }
    if (auto) { auto.checked = st.autoUpload; auto.dispatchEvent(new Event('change')); }
  }

  // ── view: #view-pengaturan ──
  // Track fill slider berbagi helper App.utils.setRangeFill (sama dgn main.js).
  const setFill = (el) => { if (App.utils) App.utils.setRangeFill(el); };

  function syncView() {
    const spd = document.getElementById('set-speed');
    const q = document.getElementById('set-q');
    const db = document.getElementById('set-db');
    if (spd) { spd.value = st.conv.speed; setFill(spd); }
    if (q) { q.value = st.conv.q; setFill(q); }
    if (db) { db.value = st.conv.db; setFill(db); }
    const sv = document.getElementById('set-speed-val');
    if (sv) sv.textContent = st.conv.speed.toFixed(2) + '×';
    const qv = document.getElementById('set-q-val');
    if (qv) qv.textContent = 'q' + st.conv.q;
    const dv = document.getElementById('set-db-val');
    if (dv) dv.textContent = (st.conv.db >= 0 ? '+' : '−') + Math.abs(st.conv.db).toFixed(1) + ' dB';
    const au = document.getElementById('set-autoupload');
    if (au) au.checked = st.autoUpload;
    const auu = document.getElementById('set-autoupdate');
    if (auu) auu.checked = st.autoUpdateCheck;
    const hi = document.getElementById('set-history');
    if (hi) hi.checked = st.historyEnabled;
  }

  function wire() {
    // di browser murni tidak ada updater — sembunyikan grup Aplikasi
    if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) {
      const box = document.getElementById('set-app-box');
      if (box) box.hidden = true;
    }

    const bindRange = (id, valId, fmt, apply) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        setFill(el);
        const v = parseFloat(el.value);
        const out = document.getElementById(valId);
        if (out) out.textContent = fmt(v);
        apply(v);
        save();
      });
    };

    bindRange('set-speed', 'set-speed-val', (v) => v.toFixed(2) + '×', (v) => {
      st.conv.speed = v;
      const spd = document.getElementById('spd');
      if (spd) { spd.value = v; spd.dispatchEvent(new Event('input')); }
    });
    bindRange('set-q', 'set-q-val', (v) => 'q' + v, (v) => {
      st.conv.q = v;
      const qs = document.getElementById('qslider');
      if (qs) { qs.value = v; qs.dispatchEvent(new Event('input')); }
    });
    bindRange('set-db', 'set-db-val', (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' dB', (v) => {
      st.conv.db = v;
      const dbs = document.getElementById('dbs');
      if (dbs) { dbs.value = v; dbs.dispatchEvent(new Event('input')); }
    });

    const bindCheck = (id, apply) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { apply(el.checked); save(); });
    };
    bindCheck('set-autoupload', (v) => {
      st.autoUpload = v;
      const auto = document.getElementById('auto-upload-check');
      if (auto) { auto.checked = v; auto.dispatchEvent(new Event('change')); }
    });
    bindCheck('set-autoupdate', (v) => { st.autoUpdateCheck = v; });
    bindCheck('set-history', (v) => { st.historyEnabled = v; });

    const clearBtn = document.getElementById('set-clear-history');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!App.history) return;
      const n = App.history.stats().count;
      if (!n) { if (App.utils) App.utils.toast('info', 'Riwayat sudah kosong'); return; }
      const ok = await App.utils.confirmDialog({
        title: 'Hapus semua riwayat?',
        text: `${n} entri riwayat akan dihapus dari perangkat ini.`,
        confirmText: 'Hapus Semua', danger: true,
      });
      if (ok) { App.history.clearAll(); App.utils.toast('success', 'Riwayat dihapus'); }
    });

    const resetBtn = document.getElementById('set-reset');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
      const ok = await App.utils.confirmDialog({
        title: 'Reset pengaturan?',
        text: 'Semua preferensi dikembalikan ke nilai bawaan.',
        confirmText: 'Reset', danger: true,
      });
      if (ok) { reset(); App.utils.toast('success', 'Pengaturan direset'); }
    });

    // default terpasang sebelum main.js init() membaca slider
    applyToSession();
    syncView();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return { get, reset };
})();
