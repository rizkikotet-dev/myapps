/* ============================================================
   main.js — boot, DOM refs, event wiring
   ============================================================ */
window.App = window.App || {};

(function () {
  const S = App.state;
  const U = App.utils;
  const E = (App.el = {});
  const $ = (id) => document.getElementById(id);

  function collectEls() {
    // key (properti App.el) → id elemen di HTML
    const IDS = {
      loader: 'loader', loaderFill: 'loader-fill', loaderPct: 'loader-pct', mainContent: 'main-content',
      dropZone: 'drop-zone', fi: 'fi',
      urlInput: 'url-input', urlBtn: 'url-btn', urlStatus: 'url-status', urlHint: 'url-hint', backendDot: 'backend-dot',
      robloxDot: 'roblox-dot', robloxLoggedOut: 'roblox-logged-out', robloxLoggedIn: 'roblox-logged-in',
      robloxAvatar: 'roblox-avatar', robloxName: 'roblox-name', robloxSub: 'roblox-sub',
      robloxStatus: 'roblox-status', robloxConfigHint: 'roblox-config-hint', robloxCreator: 'roblox-creator',
      autoUploadCheck: 'auto-upload-check',
      spd: 'spd', dbs: 'dbs', qslider: 'qslider',
      spdDisp: 'spd-disp', dbDisp: 'db-disp', qDisp: 'q-disp',
      prevBtn: 'prev-btn', convBtn: 'conv-btn', status: 'status',
      progWrap: 'prog-wrap', progFill: 'prog-fill', progLabel: 'prog-label', progPct: 'prog-pct',
      fileList: 'file-list', fc: 'fc', rows: 'rows',
      helpToggle: 'help-toggle', helpContent: 'help-content',
      hintSpeed: 'hint-speed', studioCode: 'studio-code', speedInfoVal: 'speed-info-val',
      helpSpeed: 'help-speed', helpInverse: 'help-inverse', helpCode: 'help-code',
    };
    for (const [key, id] of Object.entries(IDS)) {
      E[key] = $(id);
      if (!E[key]) console.warn(`[init] elemen #${id} tidak ditemukan`);
    }
  }

  // ── speed info live ──
  function updateSpeedInfo(v) {
    const inv = (1 / v).toFixed(3);
    if (E.speedInfoVal) E.speedInfoVal.textContent = v.toFixed(2) + '×';
    if (E.hintSpeed) E.hintSpeed.textContent = inv + '×';
    if (E.studioCode) E.studioCode.textContent = `Sound.PlaybackSpeed = ${inv}`;
    if (E.helpSpeed) E.helpSpeed.textContent = v.toFixed(2) + '×';
    if (E.helpInverse) E.helpInverse.textContent = inv;
    if (E.helpCode) E.helpCode.textContent = `Sound.PlaybackSpeed = ${inv}`;
  }
  window.copyStudioCode = () => {
    const inv = (1 / parseFloat(E.spd.value)).toFixed(3);
    U.copyText(`Sound.PlaybackSpeed = ${inv}`);
  };
  window.toggleHelp = () => {
    const show = E.helpContent.style.display === 'none' || E.helpContent.style.display === '';
    E.helpContent.style.display = show ? 'block' : 'none';
    E.helpToggle.classList.toggle('open', show);
    E.helpToggle.setAttribute('aria-expanded', String(show));
  };

  // ── backend status UI ──
  async function checkBackend() {
    const res = await App.api.checkBackend();
    if (res.online) {
      E.backendDot.classList.add('on');
      E.backendDot.title = 'Backend aktif — yt-dlp ' + res.version;
      E.urlHint.innerHTML =
        `<b style="color:var(--green)">Backend aktif</b> — paste link YouTube/SoundCloud lalu klik Ambil Audio · <code>yt-dlp ${res.version}</code>`;
      const first = !S.hasLoadedTmp;
      if (!S.backendOnlineWas || first) { S.hasLoadedTmp = true; App.files.loadTmpFiles(); App.roblox.checkRoblox(); }
    } else if (res.reason) {
      E.backendDot.classList.remove('on');
      E.backendDot.title = res.reason;
      E.urlHint.innerHTML =
        `<span style="color:var(--red)">Backend jalan tapi yt-dlp belum terinstall</span> — jalankan <code>pip install yt-dlp</code> lalu restart <code>python server.py</code>.`;
    } else {
      E.backendDot.classList.remove('on');
      E.backendDot.title = 'Backend tidak terdeteksi — python server.py lalu buka http://localhost:55502';
      E.urlHint.innerHTML =
        `<b>Backend tidak terdeteksi</b> — jalankan <code>python server.py</code> lalu buka via <code>http://localhost:55502</code> (jangan double-click file). Fallback: perintah yt-dlp tetap ditampilkan.`;
    }
    S.backendOnlineWas = res.online;
    App.files.updateConvButton();
  }

  // ── redirect query handling (?roblox=...) ──
  function handleRedirectQuery() {
    const p = new URLSearchParams(location.search);
    const r = p.get('roblox');
    if (!r) return;
    if (r === 'connected') {
      if (p.get('warn') === 'no_creator') {
        App.roblox.setRobloxStatus(
          '⚠ Login sukses TAPI akses asset ke akun BELUM dipilih. Fix: Logout → Login lagi → di layar izin Roblox CENTANG AKUN KAMU untuk Asset. Alternatif: pakai api_key di roblox_config.json.', 'err');
      } else {
        App.roblox.setRobloxStatus('✓ Login Roblox berhasil!', 'ok');
      }
    } else if (r === 'error') {
      App.roblox.setRobloxStatus('Gagal login: ' + (p.get('msg') || ''), 'err');
    } else if (r === 'logged_out') {
      App.roblox.setRobloxStatus('Logout berhasil.', 'ok');
    }
    history.replaceState({}, '', location.pathname + location.hash);
  }

  // ── wire events ──
  function wire() {
    // drop zone & file input
    E.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); E.dropZone.classList.add('drag-over'); });
    E.dropZone.addEventListener('dragleave', () => E.dropZone.classList.remove('drag-over'));
    E.dropZone.addEventListener('drop', (e) => {
      e.preventDefault(); E.dropZone.classList.remove('drag-over');
      App.files.addFiles(e.dataTransfer.files);
    });
    E.fi.addEventListener('change', () => { App.files.addFiles(E.fi.files); E.fi.value = ''; });

    // url box
    E.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.fetchFromUrl(); });
    E.urlBtn.addEventListener('click', () => window.fetchFromUrl());

    // sliders
    E.spd.addEventListener('input', () => {
      const v = parseFloat(E.spd.value);
      E.spdDisp.textContent = v.toFixed(2);
      updateSpeedInfo(v);
      if (S.isPrev && S.prevSrc) S.prevSrc.playbackRate.value = v;
      if (S.isPrev && S.fallbackAudio) S.fallbackAudio.playbackRate = v;
    });
    E.dbs.addEventListener('input', () => {
      const v = parseFloat(E.dbs.value);
      E.dbDisp.textContent = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
      if (S.isPrev && S.prevGain) S.prevGain.gain.value = Math.pow(10, v / 20);
      if (S.isPrev && S.fallbackAudio) S.fallbackAudio.volume = Math.max(0, Math.min(1, Math.pow(10, v / 20)));
    });
    E.qslider.addEventListener('input', () => { E.qDisp.textContent = E.qslider.value; });

    // track fill slider — CSS membaca var(--fill)
    [E.spd, E.dbs, E.qslider].forEach((el) => { U.setRangeFill(el); el.addEventListener('input', () => U.setRangeFill(el)); });

    // actions — prev/conv/help + tombol roblox-* pakai inline onclick di
    // index.html, jangan bind dua kali. Satu-satunya listener di sini:
    const clearBtn = document.querySelector('[data-action="clear-all"]');
    if (clearBtn) clearBtn.addEventListener('click', () => App.files.clearAll());

    // roblox login (dashboard) — logout/debug tetap inline onclick
    const loginBtn = $('roblox-login-btn');
    if (loginBtn) loginBtn.addEventListener('click', () => window.robloxLogin());

    // logout button (topbar)
    const logoutBtn = $('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
      await App.auth.doLogout();
    });

    E.autoUploadCheck.addEventListener('change', () => App.files.updateConvButton());
  }

  // ── boot loader (WASM probe) ──
  async function bootLoader() {
    let fakeP = 0;
    const fakeInt = setInterval(() => {
      fakeP = Math.min(fakeP + Math.random() * 8, 85);
      E.loaderFill.style.width = fakeP + '%';
    }, 200);
    try {
      E.loaderPct.textContent = 'Mengunduh OGG encoder WASM…';
      const enc = await WasmMediaEncoder.createOggEncoder();
      enc.close && enc.close();
      clearInterval(fakeInt);
      E.loaderFill.style.width = '100%';
      await new Promise(r => setTimeout(r, 250));
      E.loader.style.display = 'none';
      E.mainContent.style.display = 'block';
      return true;
    } catch (e) {
      clearInterval(fakeInt);
      E.loaderPct.innerHTML = '❌ Gagal memuat encoder: ' + U.escapeHtml(e.message) +
        '<br><span style="font-size:.75rem">Pastikan koneksi internet aktif (WASM dari CDN).</span>';
      console.error(e);
      return false;
    }
  }

  // ── halaman tentang ──
  function openExternal(url) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
    else window.open(url, '_blank');
  }
  function initAboutPage() {
    const verEl = $('about-version');
    if (!verEl) return;
    const tauri = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (tauri && window.__TAURI__.app && typeof window.__TAURI__.app.getVersion === 'function') {
      window.__TAURI__.app.getVersion().then((v) => { verEl.textContent = 'Desktop v' + v; }).catch(() => {});
    } else {
      verEl.textContent = 'Web \u2014 python server.py';
    }
    const A = App.CONFIG.ABOUT;
    const dev = $('about-dev');
    if (dev) dev.textContent = A.developer;
    const links = $('about-links');
    if (links) {
      const items = [
        ['brand-github', 'GitHub', A.links.github, 'about-btn-github'],
        ['brand-discord', 'Discord', A.links.discord, 'about-btn-discord'],
        ['heart', 'Donasi', A.links.donate, 'about-btn-donate'],
      ];
      links.innerHTML = items.map(([icon, label, url, cls]) =>
        `<button type="button" class="about-btn ${cls}" data-url="${U.escapeHtml(url)}"><i class="ti ti-${icon}"></i> ${label}</button>`
      ).join('');
      links.querySelectorAll('.about-btn').forEach(btn =>
        btn.addEventListener('click', () => openExternal(btn.dataset.url)));
    }
  }

  async function init() {
    collectEls();
    wire();
    initAboutPage();

    // initial values
    E.spdDisp.textContent = parseFloat(E.spd.value).toFixed(2);
    E.dbDisp.textContent = '−' + Math.abs(parseFloat(E.dbs.value)).toFixed(1);
    updateSpeedInfo(parseFloat(E.spd.value));

    handleRedirectQuery();

    const ok = await bootLoader();
    if (!ok) return;

    await checkBackend();
    await App.auth.checkGate();
    setInterval(checkBackend, 10000);
    setInterval(() => App.roblox.checkRoblox(), 15000);

    console.log('%cValency Studio | Audio Converter ready', 'color:#f2a33c;font-weight:bold');
  }

  // expose untuk modul lain yang butuh checkBackend
  App.boot = { checkBackend, init };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
