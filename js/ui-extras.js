/* ============================================================
   ui-extras.js — osiloskop kecepatan (canvas) + aksesibilitas
   drop-zone. Tidak bergantung pada App.*; elemen opsional,
   keluar diam-diam bila tidak ditemukan.
   ============================================================ */
(function () {
  // drop-zone: div dengan onclick atribut tidak aktif via keyboard
  var dz = document.getElementById('drop-zone');
  if (dz) {
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dz.click(); }
    });
  }

  var canvas = document.getElementById('wave-canvas');
  var spd = document.getElementById('spd');
  if (!canvas || !spd || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var themeMQ = window.matchMedia('(prefers-color-scheme: dark)');

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  var colWave = cssVar('--accent');
  var colGrid = cssVar('--text3');
  themeMQ.addEventListener('change', function () { colWave = cssVar('--accent'); colGrid = cssVar('--text3'); });

  var W = 0, H = 0;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (W < 2 || H < 2) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  resize();

  var freq = parseFloat(spd.value) || 2.3;
  var target = freq;
  var phase = 0;

  spd.addEventListener('input', function () { target = parseFloat(spd.value) || 1; });

  function draw() {
    if (W < 2 || H < 2) return;
    ctx.clearRect(0, 0, W, H);
    var mid = H / 2;

    // graticule ala layar osiloskop
    ctx.strokeStyle = colGrid;
    ctx.globalAlpha = 0.13;
    ctx.lineWidth = 1;
    var stepX = W / 8;
    for (var gx = stepX; gx < W - 1; gx += stepX) {
      ctx.beginPath(); ctx.moveTo(gx, 5); ctx.lineTo(gx, H - 5); ctx.stroke();
    }
    var stepY = H / 4;
    for (var gy = stepY; gy < H - 1; gy += stepY) {
      ctx.beginPath(); ctx.moveTo(5, gy); ctx.lineTo(W - 5, gy); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // garis referensi tengah
    ctx.strokeStyle = colGrid;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(6, mid); ctx.lineTo(W - 6, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // label sudut
    ctx.fillStyle = colGrid;
    ctx.globalAlpha = 0.55;
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('SCOPE · 1 \u00F7 SPEED', W - 9, 14);
    ctx.globalAlpha = 1;

    // gelombang: jumlah siklus mengikuti speed — makin cepat makin rapat
    var cycles = 3 + freq * 2.6;
    var amp = H * 0.36;
    ctx.beginPath();
    for (var x = 0; x <= W; x += 2) {
      var t = x / W;
      var env = 0.55 + 0.45 * Math.sin(Math.PI * t);
      var y = mid
        + Math.sin(t * cycles * Math.PI * 2 + phase) * amp * env * 0.72
        + Math.sin(t * cycles * Math.PI * 4 - phase * 1.7) * amp * env * 0.28;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colWave;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = colWave;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  var last = 0;
  function loop(now) {
    var dt = last ? (now - last) / 1000 : 0.016;
    last = now;
    if (reduceMotion.matches) {
      target = freq; // tanpa animasi: nilai langsung, frame statis
    } else {
      phase += dt * (1.1 + freq * 1.3);
    }
    freq += (target - freq) * Math.min(1, dt * 12);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* ── update checker (desktop/Tauri saja) ───────────────────────
     Plugin updater Tauri v2: cek latest.json di GitHub Releases,
     unduh + install silent, lalu relaunch via tauri-plugin-process. */
  var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return; // browser biasa (server.py murni): tidak ada updater

  var btn = document.createElement('button');
  btn.className = 'btn-outline update-btn';
  btn.innerHTML = '<i class="ti ti-refresh"></i> Cek Update';
  btn.addEventListener('click', checkUpdate);
  // taruh di topbar (sisi kanan, sebelah tombol About) — selalu terlihat
  var anchor = document.querySelector('.topbar-actions');
  if (anchor) anchor.appendChild(btn);

  function setBtn(html) { btn.innerHTML = html; }
  function busy(on, label) { btn.disabled = on; setBtn('<i class="ti ti-refresh"></i> ' + label); }

  async function checkUpdate() {
    try {
      busy(true, 'Memeriksa…');
      var update = await invoke('plugin:updater|check', { options: {} });
      if (!update || !update.available) {
        await Swal.fire({ title: 'Tidak ada update', text: 'Aplikasi sudah versi terbaru.', icon: 'success' });
        return;
      }
      var go = await Swal.fire({
        title: 'Update tersedia',
        text: 'Versi ' + update.version + ' siap diinstall. Unduh, install otomatis, lalu restart aplikasi?',
        icon: 'question', showCancelButton: true,
        confirmButtonText: 'Install & Restart', cancelButtonText: 'Nanti',
        buttonsStyling: false,
      });
      if (!go.isConfirmed) return;
      // downloadAndInstall via plugin command + Channel untuk progress
      var Channel = window.__TAURI__.core.Channel;
      var ch = new Channel();
      var lastPct = -1;
      ch.onmessage = function (evt) {
        if (evt && evt.event === 'Started' && evt.data.contentLength) {
          ch._total = evt.data.contentLength;
        } else if (evt && evt.event === 'Progress') {
          var pct = ch._total ? Math.min(99, Math.round((evt.data.chunkLength / ch._total) * 100)) : null;
          if (pct !== null && pct !== lastPct) { lastPct = pct; busy(true, 'Mengunduh ' + pct + '%'); }
        } else if (evt && evt.event === 'Finished') {
          busy(true, 'Installing…');
        }
      };
      await invoke('plugin:updater|download_and_install', { onEvent: ch });
      busy(true, 'Restarting…');
      await window.__TAURI__.process.relaunch();
    } catch (e) {
      console.error('[update]', e);
      setBtn('<i class="ti ti-alert-circle"></i> Gagal');
      setTimeout(function () { setBtn('<i class="ti ti-refresh"></i> Cek Update'); }, 4000);
      if (typeof Swal !== 'undefined' && !(Swal.isVisible && Swal.isVisible())) {
        var raw = String(e).slice(0, 200);
        // manifest latest.json belum ada / tidak valid di endpoint rilis
        var hint = /release JSON|404|not found|status code 4/i.test(raw)
          ? 'Server pembaruan belum memiliki rilis yang dapat diunduh (latest.json belum tersedia). Coba lagi nanti, atau unduh installer terbaru dari halaman Releases GitHub.'
          : raw;
        Swal.fire({ title: 'Update gagal', text: hint, icon: 'error' });
      }
    }
  }

  // cek otomatis sekali saat boot (diam jika tak ada update)
  setTimeout(function () {
    invoke('plugin:updater|check', { options: {} }).then(function (u) {
      if (u && u.available) checkUpdateFromAuto(u);
    }).catch(function () {});
  }, 5000);

  function checkUpdateFromAuto(update) {
    Swal.fire({
      title: 'Update tersedia',
      text: 'Versi ' + update.version + ' tersedia. Install sekarang?',
      icon: 'info', showCancelButton: true,
      confirmButtonText: 'Update Sekarang', cancelButtonText: 'Nanti',
      buttonsStyling: false,
    }).then(function (go) {
      if (go.isConfirmed) checkUpdate();
    });
  }
})();
