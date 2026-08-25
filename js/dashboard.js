/* ============================================================
   dashboard.js — halaman Dashboard (Fase 2)
   Kartu statistik dari App.history.stats(), status cepat
   (mirror dot #backend-dot & #roblox-dot — sumber tunggal di
   main.js/roblox.js), versi aplikasi + shortcut update, dan
   5 aktivitas terakhir. Kontrak CSS: .stat-*, .dash-* di app.css.
   ============================================================ */
window.App = window.App || {};

App.dashboard = (() => {
  const H = () => App.history;

  const $ = (id) => document.getElementById(id);

  function fmtSize(b) {
    if (H() && H().fmtSize) return H().fmtSize(b);
    if (b == null) return '—';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  function timeAgo(ts) {
    const d = Date.now() - ts;
    if (d < 60e3) return 'baru saja';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' mnt lalu';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' jam lalu';
    return Math.floor(d / 86400e3) + ' hari lalu';
  }

  function esc(s) {
    return App.utils && App.utils.escapeHtml ? App.utils.escapeHtml(s) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── kartu statistik ──
  function renderStats() {
    if (!$('stat-count') || !H()) return;
    const st = H().stats();
    $('stat-count').textContent = String(st.okCount);
    $('stat-count-foot').textContent = st.count
      ? (st.errCount ? `${st.errCount} gagal` : 'semua sukses')
      : 'belum ada aktivitas';

    const savedBytes = Math.max(0, (st.totalOrig || 0) - (st.totalOgg || 0));
    $('stat-saved').textContent = st.okCount ? fmtSize(savedBytes) : '—';
    $('stat-saved-foot').textContent = st.okCount
      ? `${st.savedPct}% dari ${fmtSize(st.totalOrig)}`
      : 'ukuran asli → OGG';

    $('stat-speed').textContent = st.avgSpeed ? st.avgSpeed.toFixed(2) + '×' : '—';

    $('stat-roblox').textContent = String(st.robloxCount);
    $('stat-roblox-foot').textContent = st.okCount
      ? `asset · ${st.downloadCount} unduhan lokal`
      : 'asset berhasil';
  }

  // ── aktivitas terakhir ──
  function recentRowHtml(e) {
    const savedPct = e.sizeOrig && e.sizeOgg ? Math.max(0, Math.round((1 - e.sizeOgg / e.sizeOrig) * 100)) : null;
    const target = e.target === 'roblox' ? 'Roblox' : 'Unduhan';
    const bits = [esc(timeAgo(e.ts)), target];
    if (savedPct != null) bits.push('<span class="hist-saved">−' + savedPct + '%</span>');
    const badge = e.status === 'err'
      ? '<span class="badge be">Gagal</span>'
      : (e.target === 'roblox'
        ? (/REJECTED|BLOCKED/i.test(e.mod || '') ? '<span class="badge be">Ditolak</span>' : '<span class="badge bd">OK</span>')
        : '<span class="badge bd">OK</span>');
    return `<div class="dash-recent-row" data-hid="${e.id}">
      <span class="ficon"><i class="ti ti-file-music icon"></i></span>
      <div class="hist-info">
        <p class="hist-name">${esc(e.name)}</p>
        <p class="hist-meta">${bits.join(' · ')}</p>
      </div>
      ${badge}
    </div>`;
  }

  function renderRecent() {
    const listEl = $('dash-recent-list');
    const emptyEl = $('dash-recent-empty');
    if (!listEl || !H()) return;
    const last = H().stats().last || [];
    listEl.innerHTML = last.map(recentRowHtml).join('');
    if (emptyEl) emptyEl.style.display = last.length ? 'none' : '';
  }

  // ── status cepat: mirror dot sumber tunggal ──
  function mirrorDot(srcId, dotId, valId, transform) {
    const src = $(srcId), dot = $(dotId), val = valId ? $(valId) : null;
    if (!src || !dot) return;
    const sync = () => {
      const on = src.classList.contains('on');
      dot.classList.toggle('on', on);
      if (!val) return;
      const text = transform ? transform(on, src.title || '') : (on ? 'Aktif' : (src.title || 'Offline'));
      val.textContent = text;
      val.classList.toggle('ok', on);
      val.title = src.title || '';
    };
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ['class', 'title'] });
    }
    sync();
  }

  function renderVersion() {
    const el = $('ds-app-val');
    if (!el) return;
    const tauri = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (tauri && window.__TAURI__.app && typeof window.__TAURI__.app.getVersion === 'function') {
      window.__TAURI__.app.getVersion().then((v) => {
        el.textContent = 'Desktop v' + v;
        const btn = $('dash-update-btn');
        if (btn) {
          btn.hidden = !document.querySelector('.topbar-actions .update-btn');
          btn.addEventListener('click', () => {
            const ub = document.querySelector('.topbar-actions .update-btn');
            if (ub) ub.click();
          });
        }
      }).catch(() => { el.textContent = 'Desktop'; });
    } else {
      el.textContent = 'Web — server.py';
    }
  }

  function render() {
    renderStats();
    renderRecent();
  }

  function wire() {
    if (H() && typeof H().subscribe === 'function') H().subscribe(() => render());
    window.addEventListener('hashchange', () => {
      if (location.hash.replace(/^#\/?/, '') === 'dashboard') render();
    });

    mirrorDot('backend-dot', 'dash-dot-backend', 'ds-backend-val', (on, title) => {
      if (on) {
        const m = title.match(/yt-dlp\s+(\S+)/);
        return m ? 'Aktif · yt-dlp ' + m[1] : 'Aktif';
      }
      return title || 'Offline';
    });
    // dot akun Roblox di panel Akun (teks status sudah tampil via blok login/info)
    mirrorDot('roblox-dot', 'dash-dot-roblox');

    const listEl = $('dash-recent-list');
    if (listEl) listEl.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      if (App.nav) App.nav.go('riwayat');
    });

    render();
    renderVersion();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return { render };
})();
