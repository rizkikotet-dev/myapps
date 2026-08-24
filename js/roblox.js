/* ============================================================
   roblox.js — OAuth status, login/logout, auto-upload & realtime polling
   ============================================================ */
window.App = window.App || {};

App.roblox = (() => {
  const S = () => App.state;
  const U = () => App.utils;
  const E = () => App.el;

  function setRobloxStatus(msg, kind) {
    E().robloxStatus.textContent = msg;
    E().robloxStatus.className = kind ? `status-line ${kind}` : 'status-line';
  }

  // ── login state ──
  async function checkRoblox() {
    try {
      const cfg = await App.api.robloxConfig();
      if (!cfg.configured) {
        if (E().robloxConfigHint) {
          E().robloxConfigHint.style.display = 'block';
          E().robloxConfigHint.innerHTML =
            `Belum dikonfigurasi — buat app di <a href="https://create.roblox.com/dashboard/credentials" target="_blank">Creator Dashboard</a> ` +
            `(redirect: <code>${cfg.redirect_uri || 'http://127.0.0.1:8000/api/roblox/callback'}</code>), atau isi <code>api_key</code> di <code>roblox_config.json</code>.`;
        }
        setDot(false, 'Belum dikonfigurasi');
        S().isRobloxLogged = false; App.files.updateConvButton();
        return false;
      }
      if (E().robloxConfigHint) E().robloxConfigHint.style.display = 'none';

      const me = await App.api.robloxMe();
      if (me.logged) {
        setDot(true, 'Login sebagai ' + (me.userinfo?.preferred_username || me.userinfo?.sub));
        E().robloxLoggedOut.style.display = 'none';
        E().robloxLoggedIn.style.display = 'block';
        E().robloxName.textContent = me.userinfo?.preferred_username || me.userinfo?.name || '-';
        E().robloxSub.textContent = me.userinfo?.sub ? 'ID ' + me.userinfo.sub : '';
        E().robloxAvatar.src = me.userinfo?.picture || '';
        E().robloxAvatar.style.display = me.userinfo?.picture ? '' : 'none';
        if (E().robloxCreator) E().robloxCreator.textContent = 'userId ' + (me.userinfo?.sub || '-');
        S().isRobloxLogged = true; App.files.updateConvButton();
        return true;
      }
      setDot(false, 'Belum login');
    } catch (_) { setDot(false, 'Backend offline'); }
    S().isRobloxLogged = false;
    showLoggedOut();
    App.files.updateConvButton();
    return false;
  }

  function setDot(on, title) {
    E().robloxDot.classList.toggle('on', !!on);
    E().robloxDot.title = title || '';
  }
  function showLoggedOut() {
    E().robloxLoggedOut.style.display = 'block';
    E().robloxLoggedIn.style.display = 'none';
  }

  window.robloxLogin = async () => {
    try {
      await App.api.robloxLogin();
    } catch (e) {
      setRobloxStatus('Tidak bisa membuka halaman login: ' + e.message, 'err');
      return;
    }
    // mode desktop: login terjadi di browser eksternal — poll status sampai selesai
    if (!window.__TAURI__?.core?.invoke) return;
    setRobloxStatus('Browser terbuka — selesaikan login Roblox di sana…', '');
    for (let i = 0; i < 60; i++) { // ~3 menit
      await new Promise(r => setTimeout(r, 3000));
      if (await App.roblox.checkRoblox()) {
        setRobloxStatus('✓ Login berhasil.', 'ok');
        U().toast('success', 'Login Roblox berhasil');
        return;
      }
    }
    setRobloxStatus('Login belum selesai / dibatalkan — coba lagi.', 'err');
  };

  window.robloxLogout = async () => {
    const ok = await U().confirmDialog({ title: 'Logout Roblox?', text: 'Auto-upload akan nonaktif sampai login lagi.', confirmText: 'Logout' });
    if (!ok) return;
    await App.api.robloxLogout();
    S().isRobloxLogged = false;
    showLoggedOut(); setDot(false);
    setRobloxStatus('Logout berhasil.', 'ok');
    App.files.updateConvButton();
  };

  window.robloxDebug = async () => {
    setRobloxStatus('Memeriksa token & resources…', '');
    try {
      const j = await App.api.robloxDebug();
      let msg;
      const creatorIds = (((j.resources || {}).resource_infos || [{}])[0].resources || {}).creator?.ids || [];
      if (!j.has_token) msg = 'Tidak ada token — login dulu.';
      else {
        msg = `token active=${j.introspect?.active}, scope=${j.introspect?.scope || j.scope_stored}, expires_in=${j.expires_in_sec}s | creator granted: [${creatorIds.join(',')}]`;
        if (creatorIds.length === 0) msg += ' ⚠ creator kosong → Logout + Login ulang, centang akun kamu untuk Asset! Atau pakai api_key.';
      }
      setRobloxStatus(msg, creatorIds.length > 0 ? 'ok' : 'err');
      console.log('[roblox debug]', j);
    } catch (e) {
      setRobloxStatus('Debug gagal: ' + e.message, 'err');
    }
  };

  // ── upload + polling ──
  async function pollRobloxAudit(item, assetId) {
    const t0 = Date.now();
    for (let i = 0; i < App.CONFIG.AUDIT_MAX_TRIES; i++) {
      await new Promise(r => setTimeout(r, App.CONFIG.AUDIT_INTERVAL_MS));
      try {
        const aj = await App.api.robloxAsset(assetId);
        const st = aj.moderationResult?.moderationState || aj.moderationState || '';
        if (st && st !== item.roblox.moderation) {
          item.roblox.moderation = st;
          App.files.renderRows();
          if (/APPROVED/i.test(st)) { setRobloxStatus(`✓ Disetujui — Asset ID ${assetId}`, 'ok'); U().toast('success', `${aj.displayName || 'Audio'} disetujui Roblox`); return; }
          if (/REJECTED|BLOCKED/i.test(st)) { item.roblox.status = 'rejected'; App.files.renderRows(); setRobloxStatus(`✗ Ditolak ${st}`, 'err'); return; }
          setRobloxStatus(`⏳ Reviewing ID ${assetId}…`, '');
        } else {
          const s = Math.round((Date.now() - t0) / 1000);
          App.files.updateRowMeta(item, `Reviewing… <span class="rwait">${s}s</span><span class="adots"><i>.</i><i>.</i><i>.</i></span>`);
        }
      } catch (_) {}
    }
  }

  async function pollRobloxOperation(item, operationId) {
    item.roblox.status = 'polling';
    item.roblox.progress = null;
    item.roblox.operationId = operationId;
    render(item);
    const t0 = Date.now();
    for (let i = 0; i < App.CONFIG.POLL_OP_MAX_TRIES; i++) {
      await new Promise(r => setTimeout(r, App.CONFIG.POLL_OP_INTERVAL_MS));
      try {
        const pj = await App.api.robloxOperation(operationId);
        if (!pj.done) {
          const s = Math.round((Date.now() - t0) / 1000);
          item.roblox.msg = `Pending… (${i + 1})`;
          App.files.updateRowMeta(item, `Menunggu antrian Roblox <span class="rwait">${s}s</span><span class="adots"><i>.</i><i>.</i><i>.</i></span>`);
          setRobloxStatus('⏳ Moderasi pending…', '');
          continue;
        }
        if (pj.error) {
          // error operasional Roblox BUKAN error jaringan — hentikan polling, tandai gagal
          const m = String(pj.error.message || JSON.stringify(pj.error)).slice(0, 220);
          item.roblox.status = 'error'; item.roblox.error = m;
          render(item); setRobloxStatus(`✗ Upload gagal (operation): ${m}`, 'err'); U().toast('error', 'Upload Roblox ditolak');
          return;
        }
        if (pj.response) {
          const assetId = pj.response.assetId || pj.response.asset?.assetId || '';
          const mod = pj.response.moderationResult?.moderationState || '';
          const rejected = /REJECTED|BLOCKED/i.test(mod);
          item.roblox.status = rejected ? 'rejected' : 'done';
          item.roblox.assetId = assetId;
          item.roblox.moderation = mod;
          render(item);
          if (rejected) { setRobloxStatus(`✗ Roblox menolak: ${mod}`, 'err'); U().toast('error', 'Asset ditolak moderasi'); return; }
          if (/APPROVED/i.test(mod)) { setRobloxStatus(`✓ Disetujui — Asset ID ${assetId}`, 'ok'); return; }
          setRobloxStatus(`✓ Upload DITERIMA — Asset ID ${assetId}. Moderasi berjalan, status update otomatis…`, 'ok');
          pollRobloxAudit(item, assetId); // background
          return;
        }
      } catch (e) { console.warn('poll op error', e); }
    }
    item.roblox.msg = 'Masih pending — cek Creator Dashboard';
    render(item);
  }

  function render(item) { App.files.renderRows(); }

  async function uploadToRoblox(blob, filename, displayName, item) {
    const checked = E().autoUploadCheck?.checked;
    if (!checked) {
      if (item) { item.roblox = { status: 'skip' }; App.files.renderRows(); }
      return;
    }
    if (!S().isRobloxLogged || !S().backendOnline) {
      if (item) { item.roblox = { status: 'error', error: 'Belum login / server offline' }; App.files.renderRows(); }
      setRobloxStatus('Skip auto-upload: belum login / server offline.', 'err');
      return;
    }
    // pastikan masih logged
    const me = await App.api.robloxMe();
    if (!me.logged) {
      if (item) { item.roblox = { status: 'error', error: 'Sesi kadaluarsa' }; App.files.renderRows(); }
      setRobloxStatus('Sesi Roblox kadaluarsa — login ulang.', 'err');
      S().isRobloxLogged = false; showLoggedOut();
      return;
    }

    if (item) {
      item.roblox = { ...(item.roblox || {}), status: 'uploading', msg: 'Uploading…', progress: 0 };
      App.files.renderRows();
    }
    setRobloxStatus(`Uploading ${filename} ke Roblox… 0%`, '');

    try {
      const j = await App.api.robloxUpload(blob, filename, displayName, (loaded, total) => {
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        if (item) {
          item.roblox.progress = pct;
          App.files.updateRowProgress(item);
        }
        setRobloxStatus(`Uploading ${filename} ke Roblox… ${pct}% (${U().fmtSize(loaded)}/${U().fmtSize(total)})`, '');
      });
      const opId = j.operationId || (j.operation ? String(j.operation).split('/').pop() : null);
      if (j.asset?.assetId) {
        if (item) {
          Object.assign(item.roblox, { status: 'done', assetId: j.asset.assetId, moderation: j.asset.moderationResult?.moderationState || '' });
          App.files.renderRows();
        }
        setRobloxStatus(`✓ Berhasil — Asset ID ${j.asset.assetId} (${filename})`, 'ok');
      } else if (opId) {
        if (item) await pollRobloxOperation(item, opId);
        else {
          setRobloxStatus(`✓ Operation ${opId} diterima — cek dashboard.`, 'ok');
        }
      } else {
        if (item) { Object.assign(item.roblox, { status: 'done', msg: JSON.stringify(j).slice(0, 40) }); App.files.renderRows(); }
        setRobloxStatus('✓ Response: ' + JSON.stringify(j).slice(0, 160), 'ok');
      }
    } catch (e) {
      console.error('roblox upload err', e);
      if (item) { item.roblox = { ...(item.roblox || {}), status: 'error', error: e.message.slice(0, 220) }; App.files.renderRows(); }
      setRobloxStatus(`Gagal upload ${filename}: ${String(e.message).slice(0, 260)}`, 'err');
      U().toast('error', 'Upload Roblox gagal');
      if (e.message.includes('relogin') || /not authenticated/i.test(e.message)) {
        const go = await U().confirmDialog({
          title: 'Perlu login ulang?',
          text: 'Token OAuth tidak punya akses asset ke akun ini. Buka halaman login sekarang?',
          confirmText: 'Login Ulang',
        });
        if (go) window.robloxLogin();
      }
    }
  }

  // KONTRAK: uploadToRoblox TIDAK pernah throw — kegagalan dicatat di item.roblox;
  // loop di bawah bergantung pada itu agar satu part gagal tak menghentikan sisanya.
  // Upload berurutan untuk satu file (bisa multi-part). Mengembalikan hasil per part.
  async function uploadParts(item, parts) {
    const results = [];
    const doneParts = [];
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      item.roblox = { status: 'idle', parts: doneParts, partLabel: parts.length > 1 ? `Part ${k + 1}/${parts.length}` : '' };
      await uploadToRoblox(p.blob, p.fileName, p.displayName, item);
      doneParts.push({
        name: p.displayName,
        assetId: item.roblox.assetId || '',
        status: item.roblox.status,
        moderation: item.roblox.moderation || '',
        error: item.roblox.error || '',
      });
      item.roblox.parts = doneParts;
      results.push(doneParts[doneParts.length - 1]);
    }
    return results;
  }

  // Dialog ringkasan multi-part: tabel Part|Asset ID|Moderasi + copy daftar rbxassetid.
  function showPartsSummary(item) {
    const parts = (item.roblox && item.roblox.parts) || [];
    if (parts.length < 2) return;
    const rows = parts.map((p, i) => {
      const rejected = p.status === 'rejected' || /REJECTED|BLOCKED/i.test(p.moderation || '');
      const modCell = !p.assetId
        ? '<span class="pt-fail">✗ gagal</span>'
        : (rejected ? '<span class="pt-fail">Ditolak ✗</span>'
                    : U().escapeHtml(App.files.moderationLabel(p.moderation)));
      return `<tr><td>${i + 1}</td><td class="pt-name">${U().escapeHtml(p.name)}</td><td>${
        p.assetId ? '<code>rbxassetid://' + U().escapeHtml(p.assetId) + '</code>'
                  : '<span class="pt-fail">✗ ' + U().escapeHtml((p.error || 'gagal').slice(0, 60)) + '</span>'
      }</td><td>${modCell}</td></tr>`;
    }).join('');
    const idText = parts.filter(p => p.assetId && !(p.status === 'rejected' || /REJECTED|BLOCKED/i.test(p.moderation || ''))).map(p => 'rbxassetid://' + p.assetId).join('\n');
    if (typeof Swal === 'undefined') { U().copyText(idText); return; }
    Swal.fire(U().swalBase({
      title: 'Upload Multi-Part Selesai',
      html: `<table class="parts-table"><thead><tr><th>#</th><th>Nama</th><th>Asset ID</th><th>Moderasi</th></tr></thead><tbody>${rows}</tbody></table>
             <p class="parts-hint">Susun ID berurutan di Roblox Studio agar penyambungan mulus. Moderasi berjalan otomatis — status update tanpa perlu aksi.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Copy ID',
      cancelButtonText: 'Tutup',
      reverseButtons: true,
      preConfirm: () => { U().copyText(idText); return false; },
    }));
  }

  return { checkRoblox, setRobloxStatus, uploadToRoblox, uploadParts, showPartsSummary, pollRobloxOperation };
})();
