/* ============================================================
   nav.js — hash router untuk shell sidebar (Fase 0)
   View: dashboard | konversi | riwayat | pengaturan.
   Tanpa dependensi App.*; jalan di browser & Tauri (file://).
   Kontrak CSS: .view / .view-head / .nav-item / .sidebar.open /
   body.nav-open — lihat base.css & app.css.
   ============================================================ */
(function () {
  var VIEWS = ['dashboard', 'konversi', 'riwayat', 'pengaturan', 'tentang'];
  var DEFAULT_VIEW = 'dashboard';

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    return VIEWS.indexOf(h) !== -1 ? h : null;
  }

  function apply() {
    var v = parseHash() || DEFAULT_VIEW;
    VIEWS.forEach(function (name) {
      var sec = document.getElementById('view-' + name);
      if (sec) sec.hidden = name !== v;
      var head = document.querySelector('[data-view-head="' + name + '"]');
      if (head) head.hidden = name !== v;
    });
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var on = a.getAttribute('data-view') === v;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    close();
    window.scrollTo(0, 0);
  }

  /* ── off-canvas (layar sempit) ── */
  var sidebar = document.getElementById('sidebar');
  var toggle = document.getElementById('nav-toggle');

  function open() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    document.body.classList.add('nav-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
  }
  function close() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  if (toggle) toggle.addEventListener('click', function () {
    if (sidebar && sidebar.classList.contains('open')) close();
    else open();
  });
  var scrim = document.getElementById('side-scrim');
  if (scrim) scrim.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  /* ── dot backend di sidebar mengikuti #backend-dot ──
     (#backend-dot adalah sumber tunggal dari checkBackend di main.js) */
  var srcDot = document.getElementById('backend-dot');
  var sbDot = document.getElementById('sb-dot-backend');
  if (srcDot && sbDot && typeof MutationObserver !== 'undefined') {
    var syncDot = function () {
      sbDot.classList.toggle('on', srcDot.classList.contains('on'));
      sbDot.title = srcDot.title || 'Status backend';
    };
    new MutationObserver(syncDot).observe(srcDot, { attributes: true, attributeFilter: ['class', 'title'] });
    syncDot();
  }

  window.addEventListener('hashchange', apply);
  apply();

  window.App = window.App || {};
  App.nav = { go: function (v) { location.hash = '#/' + v; } };
})();
