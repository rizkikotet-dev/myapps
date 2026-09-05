/* ============================================================
   auth.js — Google & Discord OAuth status, login/logout
   ============================================================ */
window.App = window.App || {};

App.auth = (() => {
  const S = () => App.state;
  const U = () => App.utils;
  const E = () => App.el;

  function setAuthStatus(provider, msg, kind) {
    const el = provider === 'google' ? E().googleStatus : E().discordStatus;
    if (el) {
      el.textContent = msg;
      el.className = kind ? `status-line ${kind}` : 'status-line';
    }
  }

  async function checkAuth() {
    try {
      const cfg = await App.api.authConfig();
      
      // Google
      if (cfg.google.configured) {
        if (E().googleConfigHint) E().googleConfigHint.style.display = 'none';
        if (cfg.google.userinfo) {
          showGoogleLoggedIn(cfg.google.userinfo);
          S().isGoogleLogged = true;
        } else {
          showGoogleLoggedOut();
          S().isGoogleLogged = false;
        }
      } else {
        if (E().googleConfigHint) {
          E().googleConfigHint.style.display = 'block';
          E().googleConfigHint.textContent = 'Belum dikonfigurasi — tambahkan Google OAuth credentials ke auth_config.json';
        }
        showGoogleLoggedOut();
        S().isGoogleLogged = false;
      }

      // Discord
      if (cfg.discord.configured) {
        if (E().discordConfigHint) E().discordConfigHint.style.display = 'none';
        if (cfg.discord.userinfo) {
          showDiscordLoggedIn(cfg.discord.userinfo);
          S().isDiscordLogged = true;
        } else {
          showDiscordLoggedOut();
          S().isDiscordLogged = false;
        }
      } else {
        if (E().discordConfigHint) {
          E().discordConfigHint.style.display = 'block';
          E().discordConfigHint.textContent = 'Belum dikonfigurasi — tambahkan Discord OAuth credentials ke auth_config.json';
        }
        showDiscordLoggedOut();
        S().isDiscordLogged = false;
      }
    } catch (_) {
      showGoogleLoggedOut();
      showDiscordLoggedOut();
      S().isGoogleLogged = false;
      S().isDiscordLogged = false;
    }
  }

  function showGoogleLoggedIn(userinfo) {
    if (E().googleLoggedOut) E().googleLoggedOut.style.display = 'none';
    if (E().googleLoggedIn) E().googleLoggedIn.style.display = 'block';
    if (E().googleName) E().googleName.textContent = userinfo?.name || userinfo?.email || '-';
    if (E().googleEmail) E().googleEmail.textContent = userinfo?.email || '';
    if (E().googleAvatar) {
      E().googleAvatar.src = userinfo?.picture || '';
      E().googleAvatar.style.display = userinfo?.picture ? '' : 'none';
    }
    setAuthStatus('google', 'Login sebagai ' + (userinfo?.name || userinfo?.email || 'user'), 'ok');
  }

  function showGoogleLoggedOut() {
    if (E().googleLoggedOut) E().googleLoggedOut.style.display = 'block';
    if (E().googleLoggedIn) E().googleLoggedIn.style.display = 'none';
    setAuthStatus('google', 'Belum login', '');
  }

  function showDiscordLoggedIn(userinfo) {
    if (E().discordLoggedOut) E().discordLoggedOut.style.display = 'none';
    if (E().discordLoggedIn) E().discordLoggedIn.style.display = 'block';
    const username = userinfo?.username || userinfo?.global_name || '-';
    if (E().discordName) E().discordName.textContent = username;
    if (E().discordId) E().discordId.textContent = userinfo?.id ? 'ID ' + userinfo.id : '';
    if (E().discordAvatar) {
      const avatarUrl = userinfo?.avatar 
        ? `https://cdn.discordapp.com/avatars/${userinfo.id}/${userinfo.avatar}.png`
        : '';
      E().discordAvatar.src = avatarUrl;
      E().discordAvatar.style.display = avatarUrl ? '' : 'none';
    }
    setAuthStatus('discord', 'Login sebagai ' + username, 'ok');
  }

  function showDiscordLoggedOut() {
    if (E().discordLoggedOut) E().discordLoggedOut.style.display = 'block';
    if (E().discordLoggedIn) E().discordLoggedIn.style.display = 'none';
    setAuthStatus('discord', 'Belum login', '');
  }

  window.googleLogin = async () => {
    try {
      await App.api.googleLogin();
    } catch (e) {
      setAuthStatus('google', 'Tidak bisa membuka halaman login: ' + e.message, 'err');
      return;
    }
    if (!window.__TAURI__?.core?.invoke) return;
    setAuthStatus('google', 'Browser terbuka — selesaikan login Google di sana…', '');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const me = await App.api.googleMe();
        if (me.logged) {
          setAuthStatus('google', '✓ Login berhasil.', 'ok');
          U().toast('success', 'Login Google berhasil');
          await checkAuth();
          return;
        }
      } catch (_) {}
    }
    setAuthStatus('google', 'Login belum selesai / dibatalkan — coba lagi.', 'err');
  };

  window.googleLogout = async () => {
    const ok = await U().confirmDialog({ 
      title: 'Logout Google?', 
      text: 'Akun Google akan dikeluarkan dari aplikasi ini.', 
      confirmText: 'Logout' 
    });
    if (!ok) return;
    await App.api.googleLogout();
    S().isGoogleLogged = false;
    showGoogleLoggedOut();
    setAuthStatus('google', 'Logout berhasil.', 'ok');
  };

  window.discordLogin = async () => {
    try {
      await App.api.discordLogin();
    } catch (e) {
      setAuthStatus('discord', 'Tidak bisa membuka halaman login: ' + e.message, 'err');
      return;
    }
    if (!window.__TAURI__?.core?.invoke) return;
    setAuthStatus('discord', 'Browser terbuka — selesaikan login Discord di sana…', '');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const me = await App.api.discordMe();
        if (me.logged) {
          setAuthStatus('discord', '✓ Login berhasil.', 'ok');
          U().toast('success', 'Login Discord berhasil');
          await checkAuth();
          return;
        }
      } catch (_) {}
    }
    setAuthStatus('discord', 'Login belum selesai / dibatalkan — coba lagi.', 'err');
  };

  window.discordLogout = async () => {
    const ok = await U().confirmDialog({ 
      title: 'Logout Discord?', 
      text: 'Akun Discord akan dikeluarkan dari aplikasi ini.', 
      confirmText: 'Logout' 
    });
    if (!ok) return;
    await App.api.discordLogout();
    S().isDiscordLogged = false;
    showDiscordLoggedOut();
    setAuthStatus('discord', 'Logout berhasil.', 'ok');
  };

  // ── gate helpers ──

  function gateEl()        { return document.getElementById('auth-gate'); }
  function gateErr()       { return document.getElementById('auth-gate-error'); }
  function gateLoader()    { return document.getElementById('auth-gate-loader'); }
  function gateButtons()   { return document.querySelectorAll('#auth-gate .login-btn'); }
  function appLayout()     { return document.getElementById('app-layout'); }

  function showGate(err) {
    const g = gateEl();
    if (!g) return;
    g.removeAttribute('hidden');
    // hide sidebar + main shell so they don't bleed through
    if (appLayout()) appLayout().style.visibility = 'hidden';
    if (err) {
      const e = gateErr();
      if (e) { e.textContent = err; e.classList.add('show'); }
    }
  }

  function hideGate() {
    const g = gateEl();
    if (!g) return;
    g.setAttribute('hidden', '');
    if (appLayout()) appLayout().style.visibility = '';
  }

  function gateLoading(on) {
    const l = gateLoader();
    if (l) l.classList.toggle('show', on);
    gateButtons().forEach(b => { b.disabled = on; });
  }

  // Cek apakah sudah login; tampilkan / sembunyikan gate.
  async function checkGate() {
    try {
      const cfg = await App.api.authConfig();
      const logged = (cfg.google && cfg.google.has_token) || (cfg.discord && cfg.discord.has_token);
      if (logged) {
        hideGate();
        await checkAuth();
      } else {
        showGate();
      }
    } catch (_) {
      showGate();
    }
  }

  // Dipanggil dari tombol di gate overlay.
  App.auth = App.auth || {};
  App.auth.loginFromGate = async function(provider) {
    const e = gateErr();
    if (e) { e.textContent = ''; e.classList.remove('show'); }
    gateLoading(true);

    try {
      if (provider === 'google') await App.api.googleLogin();
      else await App.api.discordLogin();
    } catch (err) {
      gateLoading(false);
      if (e) { e.textContent = 'Tidak bisa membuka login: ' + err.message; e.classList.add('show'); }
      return;
    }

    // Browser biasa: navigasi sudah terjadi (location.href), tidak sampai sini.
    // Desktop (Tauri): poll sampai session masuk.
    const meApi = provider === 'google' ? App.api.googleMe : App.api.discordMe;
    const deadline = Date.now() + 180_000; // 3 menit
    const tick = async () => {
      try {
        const me = await meApi();
        if (me.logged) { gateLoading(false); await checkGate(); return; }
      } catch (_) {}
      if (Date.now() < deadline) setTimeout(tick, 3000);
      else {
        gateLoading(false);
        if (e) { e.textContent = 'Login timeout. Coba lagi.'; e.classList.add('show'); }
      }
    };
    tick();
  };

  // Dipanggil dari tombol logout di topbar.
  App.auth.doLogout = async function() {
    await App.api.logout();
    await new Promise(r => setTimeout(r, 200));
    showGate();
    // reset roblox state juga
    if (App.roblox && App.roblox.clearState) App.roblox.clearState();
  };

  return { checkAuth, checkGate, setAuthStatus };
})();
