/* ============================================================
   history.js — riwayat konversi/upload (localStorage perangkat)
   Store: App.history.add/remove/clearAll/list/stats/updateByAsset
   View : render #view-riwayat (search, filter, aksi per baris).
   Tidak mengubah alur konversi — audio.js/roblox.js memanggil
   record*() setelah hasil final. Kontrak CSS: .hist-* di app.css.
   ============================================================ */
window.App = window.App || {};

App.history = (() => {
  const U = () => App.utils;
  const KEY = 'vs_history_v1';
  const CAP = 200;

  let entries = load();
  const subs = [];

  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(j) ? j : [];
    } catch (_) { return []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (_) {}
    subs.forEach(fn => { try { fn(entries); } catch (_) {} });
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function add(entry) {
    const e = {
      id: makeId(),
      ts: Date.now(),
      name: '',
      sizeOrig: 0,
      sizeOgg: null,
      speed: null,
      q: null,
      db: null,
      target: 'download',   // 'download' | 'roblox'
      parts: 1,
      assetIds: [],
      status: 'ok',         // 'ok' | 'err'
      mod: '',              // 'APPROVED' | 'REJECTED' | ... (roblox)
      ...entry,
    };
    entries.unshift(e);
    if (entries.length > CAP) entries.length = CAP;
    save();
    render();
    return e;
  }

  // ── hook helpers (dipanggil audio.js / roblox.js) ──
  function recordingEnabled() {
    return !(App.settings && App.settings.get && App.settings.get().historyEnabled === false);
  }

  function recordConversion(item, o) {
    if (!recordingEnabled()) return;
    const results = o.results || null;
    let status = 'ok';
    let assetIds = [];
    if (results) {
      const okParts = results.filter(r => r.assetId && r.status !== 'error' && !/REJECTED|BLOCKED/i.test(r.moderation || ''));
      assetIds = results.map(r => r.assetId).filter(Boolean);
      status = okParts.length ? 'ok' : 'err';
    }
    add({
      name: item.displayName || item.file.name,
      sizeOrig: item.file.size,
      sizeOgg: o.sizeOgg != null ? o.sizeOgg : null,
      speed: o.speed, q: o.q, db: o.db,
      target: o.target,
      parts: o.parts || 1,
      assetIds,
      status,
    });
  }

  function recordError(item, o) {
    if (!recordingEnabled()) return;
    add({
      name: item.displayName || item.file.name,
      sizeOrig: item.file.size,
      target: o.target,
      speed: o.speed, q: o.q, db: o.db,
      status: 'err',
    });
  }

  function updateByAsset(assetId, patch) {
    if (!assetId) return;
    let changed = false;
    for (const e of entries) {
      if ((e.assetIds || []).includes(String(assetId))) {
        Object.assign(e, patch);
        changed = true;
      }
    }
    if (changed) { save(); render(); }
  }

  // ── query ──
  function list(opts) {
    const o = opts || {};
    const q = (o.q || '').toLowerCase();
    return entries.filter(e => {
      if (o.filter === 'download' && e.target !== 'download') return false;
      if (o.filter === 'roblox' && e.target !== 'roblox') return false;
      if (o.filter === 'err' && e.status !== 'err') return false;
      if (q && !(e.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function stats() {
    const ok = entries.filter(e => e.status === 'ok');
    const totalOrig = ok.reduce((s, e) => s + (e.sizeOrig || 0), 0);
    const totalOgg = ok.reduce((s, e) => s + (e.sizeOgg || 0), 0);
    const speeds = ok.filter(e => e.speed).map(e => e.speed);
    return {
      count: entries.length,
      okCount: ok.length,
      errCount: entries.length - ok.length,
      downloadCount: ok.filter(e => e.target === 'download').length,
      robloxCount: ok.filter(e => e.target === 'roblox').length,
      totalOrig,
      totalOgg,
      savedPct: totalOrig ? Math.max(0, Math.round((1 - totalOgg / totalOrig) * 100)) : 0,
      avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
      last: entries.slice().sort((a, b) => b.ts - a.ts).slice(0, 5),
    };
  }

  function remove(id) {
    entries = entries.filter(e => e.id !== id);
    save(); render();
  }

  function clearAll() {
    entries = [];
    save(); render();
  }

  function subscribe(fn) { subs.push(fn); }

  // ── view: #view-riwayat ──
  const view = { q: '', filter: 'all' };

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return ''; }
  }
  function fmtSize(b) {
    if (U() && U().fmtSize) return U().fmtSize(b);
    if (b == null) return '-';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }
  function esc(s) {
    return U() && U().escapeHtml ? U().escapeHtml(s) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function targetBadge(e) {
    return e.target === 'roblox'
      ? '<span class="badge bp"><i class="ti ti-brand-roblox"></i> Roblox</span>'
      : '<span class="badge bw"><i class="ti ti-download"></i> Unduhan</span>';
  }
  function statusBadge(e) {
    if (e.status === 'err') return '<span class="badge be">Gagal</span>';
    if (e.target === 'roblox') {
      if (/REJECTED|BLOCKED/i.test(e.mod || '')) return '<span class="badge be">Ditolak</span>';
      if (!e.mod && !(e.assetIds || []).length) return '<span class="badge be">Gagal</span>';
      return e.mod ? '<span class="badge bd">Disetujui</span>' : '<span class="badge bp">Moderasi…</span>';
    }
    return '<span class="badge bd">Selesai</span>';
  }

  function rowHtml(e) {
    const savedPct = e.sizeOrig && e.sizeOgg ? Math.max(0, Math.round((1 - e.sizeOgg / e.sizeOrig) * 100)) : null;
    const sizes = e.sizeOgg != null
      ? `<span class="hist-sizes">${fmtSize(e.sizeOrig)} → <b>${fmtSize(e.sizeOgg)}</b>${savedPct != null ? ` <span class="hist-saved">−${savedPct}%</span>` : ''}</span>`
      : `<span class="hist-sizes">${fmtSize(e.sizeOrig)}</span>`;
    const metaHtml = [
      esc(fmtDate(e.ts)),
      e.speed != null ? esc(e.speed.toFixed(2) + '×') : '',
      e.q != null ? 'q' + esc(String(e.q)) : '',
      e.parts > 1 ? e.parts + ' part' : '',
      (e.assetIds || []).length === 1 ? '<code>rbxassetid://' + esc(e.assetIds[0]) + '</code>' : '',
      (e.assetIds || []).length > 1 ? e.assetIds.length + ' asset ID' : '',
    ].filter(Boolean).join(' · ');

    const actions = [];
    if (e.speed) {
      actions.push(`<button type="button" class="icon-btn" data-hact="spd" data-id="${e.id}" title="Salin kode PlaybackSpeed untuk Studio"><i class="ti ti-copy"></i></button>`);
    }
    if ((e.assetIds || []).length) {
      const idText = e.assetIds.map(id => 'rbxassetid://' + id).join('\n');
      actions.push(`<button type="button" class="icon-btn" data-hact="ids" data-id="${e.id}" data-ids="${esc(idText)}" title="Salin rbxassetid"><i class="ti ti-brand-roblox"></i></button>`);
    }
    actions.push(`<button type="button" class="icon-btn" data-hact="del" data-id="${e.id}" title="Hapus dari riwayat"><i class="ti ti-trash"></i></button>`);

    return `<div class="hist-row" data-hid="${e.id}">
      <span class="ficon"><i class="ti ti-file-music icon"></i></span>
      <div class="hist-info">
        <p class="hist-name">${esc(e.name)}</p>
        <p class="hist-meta">${metaHtml}</p>
      </div>
      <div class="hist-side">
        ${sizes}
        <div class="hist-badges">${targetBadge(e)}${statusBadge(e)}</div>
      </div>
      <div class="factions">${actions.join('')}</div>
    </div>`;
  }

  function render() {
    const listEl = document.getElementById('hist-list');
    const emptyEl = document.getElementById('hist-empty');
    const countEl = document.getElementById('hist-count');
    if (!listEl) return; // view belum ada (index lama)

    const rows = list(view);
    listEl.innerHTML = rows.map(rowHtml).join('');
    if (emptyEl) emptyEl.style.display = entries.length ? 'none' : '';
    if (emptyEl && entries.length && !rows.length) {
      emptyEl.style.display = '';
      const t = emptyEl.querySelector('.es-title');
      const s = emptyEl.querySelector('.es-sub');
      if (t) t.textContent = 'Tidak ada yang cocok';
      if (s) s.textContent = 'Coba ubah kata kunci pencarian atau filter.';
    } else if (emptyEl && entries.length) {
      const t = emptyEl.querySelector('.es-title');
      const s = emptyEl.querySelector('.es-sub');
      if (t) t.textContent = 'Belum ada riwayat';
      if (s) s.textContent = 'Setiap konversi/upload yang berhasil akan tercatat otomatis di sini.';
    }
    if (countEl) {
      const st = stats();
      countEl.textContent = st.count
        ? `${st.count} entri · ${st.okCount} sukses · hemat total ${fmtSize(st.totalOrig - st.totalOgg || 0)} (${st.savedPct}%)`
        : '';
    }
  }

  function wire() {
    const search = document.getElementById('hist-search');
    if (search) search.addEventListener('input', () => { view.q = search.value; render(); });

    const filters = document.getElementById('hist-filters');
    if (filters) filters.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.hist-chip');
      if (!chip) return;
      view.filter = chip.getAttribute('data-filter') || 'all';
      filters.querySelectorAll('.hist-chip').forEach(c => c.classList.toggle('active', c === chip));
      render();
    });

    const clearBtn = document.getElementById('hist-clear');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!entries.length) return;
      const ok = await U().confirmDialog({
        title: 'Hapus semua riwayat?',
        text: `${entries.length} entri riwayat akan dihapus dari perangkat ini.`,
        confirmText: 'Hapus Semua', danger: true,
      });
      if (ok) { clearAll(); U().toast('success', 'Riwayat dihapus'); }
    });

    const listEl = document.getElementById('hist-list');
    if (listEl) listEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-hact]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const entry = entries.find(e => e.id === id);
      if (!entry) return;
      const act = btn.getAttribute('data-hact');
      if (act === 'del') {
        remove(id);
        U().toast('info', 'Entri riwayat dihapus');
      } else if (act === 'spd') {
        U().copyText(`Sound.PlaybackSpeed = ${(1 / entry.speed).toFixed(3)}`);
      } else if (act === 'ids') {
        U().copyText(btn.getAttribute('data-ids') || '');
      }
    });

    // render ulang tiap kali view riwayat dibuka
    window.addEventListener('hashchange', () => {
      if (location.hash.replace(/^#\/?/, '') === 'riwayat') render();
    });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return { add, recordConversion, recordError, updateByAsset, list, stats, remove, clearAll, subscribe, fmtSize };
})();
