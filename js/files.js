/* ============================================================
   files.js — file list state, render, rename/remove/clear, tmp restore
   ============================================================ */
window.App = window.App || {};

App.files = (() => {
  const S = () => App.state;
  const U = () => App.utils;
  const E = () => App.el;

  const displayNameFor = (item) => item.displayName || item.file.name;
  const outNameFor = (item) => displayNameFor(item).replace(/\.[^/.]+$/, '') + '.ogg';
  const baseName = (n) => (n || '').replace(/\.[^/.]+$/, '');
  const newUid = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function newItem(file, displayName, source) {
    return { uid: newUid(), file, status: 'wait', roblox: { status: 'idle' }, displayName, source };
  }

  // ── badges ──
  function rblxBadge(item) {
    const r = item.roblox || { status: 'idle' };
    if (!r.status || r.status === 'idle' || r.status === 'skip') return '';
    const map = {
      uploading: ['rblx-up', 'Upload ' + (typeof r.progress === 'number' ? r.progress : 0) + '%'],
      polling: ['rblx-pend', 'Pending…'],
      done: ['rblx-ok', '✓ Roblox'],
      rejected: ['rblx-err', '✗ Ditolak'],
      error: ['rblx-err', '✗ Gagal'],
    };
    const [cls, label] = map[r.status] || ['rblx-pend', r.status];
    let extra = '';
    if (r.assetId) extra = ' ID ' + r.assetId;
    else if (r.operationId) extra = ' #' + r.operationId.slice(0, 6);
    else if (r.msg) extra = ' ' + r.msg.slice(0, 28);
    const live = r.status === 'uploading' ? ` data-rbadge="${item.uid}"` : '';
    const title = U().escapeHtml((r.error || r.msg || '') + (r.assetId ? ' — Asset ID ' + r.assetId : ''));
    return `<span class="rblx-badge ${cls}"${live} title="${title}">${label}${U().escapeHtml(extra)}</span>`;
  }

  function moderationLabel(st) {
    if (!st) return 'Reviewing…';
    if (/APPROVED/i.test(st)) return 'Disetujui ✓';
    if (/REJECTED|BLOCKED/i.test(st)) return 'Ditolak ✗';
    return String(st).replace(/MODERATION_STATE_/g, '') + '…';
  }

  // ── baris status roblox (moderasi / error / antrian) ──
  function rInfoHtml(item) {
    const r = item.roblox || {};
    if (r.assetId) {
      const st = r.moderation || '';
      const cls = /APPROVED/i.test(st) ? 'ok' : (/REJECTED|BLOCKED/i.test(st) ? 'err' : 'pend');
      const dots = cls === 'pend' ? '<span class="adots"><i>.</i><i>.</i><i>.</i></span>' : '';
      return `<div class="rline"><span class="rdot ${cls}"></span>Moderasi Roblox: <b class="rmod ${cls}" data-rmod="${item.uid}">${moderationLabel(st)}${dots}</b></div>`;
    }
    if (r.error) {
      return `<div class="rline err"><span class="rdot err"></span><span data-rmod="${item.uid}">${U().escapeHtml(r.error.slice(0, 110))}</span></div>`;
    }
    if (r.status === 'polling') {
      return `<div class="rline"><span class="rdot pend"></span><span data-rmod="${item.uid}">Menunggu antrian Roblox<span class="adots"><i>.</i><i>.</i><i>.</i></span></span></div>`;
    }
    if (r.status === 'uploading') {
      return `<div class="rline"><span class="rdot pend"></span>Mengunggah ke Roblox…</div>`;
    }
    return '';
  }

  // ── strip progres per-file ──
  function rowProgressHtml(item) {
    const r = item.roblox || {};
    const busy = item.status === 'proc' || r.status === 'uploading' || r.status === 'polling';
    if (!busy) return '';
    const det = r.status === 'uploading' && typeof r.progress === 'number';
    const pct = det ? r.progress : 0;
    const mode = r.status === 'polling' ? ' poll' : '';
    return `<div class="rprog-row"><div class="rprog${det ? '' : ' indet'}${mode}"><div class="rprog-fill${det ? ' det' : ''}" data-rfill="${item.uid}" style="width:${pct}%"></div></div>${det ? `<span class="rpct" data-rpct="${item.uid}">${pct}%</span>` : ''}</div>`;
  }

  function updateConvButton() {
    const auto = E().autoUploadCheck?.checked && S().isRobloxLogged && S().backendOnline;
    E().convBtn.innerHTML = auto
      ? '<i class="ti ti-cloud-upload"></i> Konversi & Auto Upload'
      : '<i class="ti ti-download"></i> Konversi & Unduh OGG';
    E().convBtn.title = auto
      ? 'Hasil langsung di-upload ke Roblox — tidak disimpan di server & tidak diunduh'
      : 'Hasil diunduh ke folder Downloads perangkat kamu (tidak disimpan di server)';
  }

  // ── render ──
  function renderRows() {
    const { fc: fcEl, rows: rowsEl } = E();
    fcEl.textContent = S().files.length;
    rowsEl.innerHTML = '';
    S().files.forEach((item, i) => {
      const bc = { wait: 'bw', proc: 'bp', done: 'bd', err: 'be' }[item.status];
      const bl = { wait: 'Menunggu', proc: 'Memproses…', done: 'Selesai', err: 'Error' }[item.status];
      const rb = rblxBadge(item);
      const row = document.createElement('div');
      row.className = 'file-row' + ((item.status === 'proc' || item.roblox?.status === 'uploading' || item.roblox?.status === 'polling') ? ' active' : '');
      row.innerHTML = `
        <span class="ficon"><i class="ti ti-file-music icon"></i></span>
        <div class="finfo">
          <div class="fname" title="${U().escapeHtml(displayNameFor(item))}">${U().escapeHtml(displayNameFor(item))}</div>
          <div class="fnew">→ <b>${U().escapeHtml(outNameFor(item))}</b> · ${U().fmtSize(item.file.size)}</div>
          ${rInfoHtml(item)}
          ${rowProgressHtml(item)}
        </div>
        <div class="fside">
          <div class="fbadges">
            <span class="badge ${bc}">${bl}</span>
            ${rb}
          </div>
          <div class="factions">
            <button class="icon-btn" data-action="rename" data-i="${i}" title="Rename"><i class="ti ti-pencil"></i></button>
            <button class="icon-btn" data-action="remove" data-i="${i}" title="Hapus"><i class="ti ti-x"></i></button>
          </div>
        </div>`;
      row.querySelector('[data-action="rename"]').addEventListener('click', () => renameFile(i));
      row.querySelector('[data-action="remove"]').addEventListener('click', () => removeFile(i));
      rowsEl.appendChild(row);
    });
    updateConvButton();
  }

  // update progres upload tanpa render ulang seluruh daftar (realtime & mulus)
  function updateRowProgress(item) {
    if (!item || !item.uid) return;
    const r = item.roblox || {};
    if (typeof r.progress !== 'number') return;
    const fill = document.querySelector(`[data-rfill="${item.uid}"]`);
    if (fill) {
      fill.parentElement.classList.remove('indet');
      fill.classList.add('det');
      fill.style.width = r.progress + '%';
    }
    const badge = document.querySelector(`[data-rbadge="${item.uid}"]`);
    if (badge) badge.textContent = `Upload ${r.progress}%`;
    let pct = document.querySelector(`[data-rpct="${item.uid}"]`);
    if (!pct && fill) {
      pct = document.createElement('span');
      pct.className = 'rpct';
      pct.dataset.rpct = item.uid;
      fill.parentElement.parentElement.appendChild(pct);
    }
    if (pct) pct.textContent = r.progress + '%';
  }

  function updateRowMeta(item, html) {
    if (!item || !item.uid) return;
    const el = document.querySelector(`[data-rmod="${item.uid}"]`);
    if (el) el.innerHTML = html;
  }

  function markListVisible() {
    if (!S().files.length) return;
    E().fileList.style.display = 'block';
    E().prevBtn.disabled = false;
    E().convBtn.disabled = false;
  }

  // ── add flows ──
  function addFiles(flist) {
    for (const f of flist) {
      if (!f.type.startsWith('audio/')) continue;
      if (S().files.some(x => x.file.name === f.name && x.file.size === f.size)) continue;
      S().files.push(newItem(f, f.name));
      if (S().backendOnline) App.api.uploadTmp(f);
    }
    renderRows(); markListVisible();
  }

  function addFileFromBlob(blob, filename, source = 'url') {
    const clean = U().sanitizeFilename(filename);
    if (S().files.some(x => x.file.name === clean && x.file.size === blob.size)) return null;
    const file = new File([blob], clean, { type: blob.type || 'audio/mpeg' });
    S().files.push(newItem(file, clean, source));
    renderRows(); markListVisible();
    return clean;
  }

  // ── actions ──
  async function renameFile(i) {
    const item = S().files[i];
    if (!item) return;
    const ext = item.file.name.split('.').pop() || 'mp3';
    const val = await U().inputDialog({
      title: 'Rename Audio',
      text: `Ekstensi .${ext} dipertahankan otomatis.`,
      value: baseName(displayNameFor(item)),
      placeholder: 'nama-audio-baru',
    });
    if (val === null) return;
    const clean = U().sanitizeFilename(val).replace(/\.[^/.]+$/, '');
    if (!clean) return;
    const oldFull = item.file.name;
    const newFull = clean + '.' + ext;
    try { item.file = new File([item.file], newFull, { type: item.file.type }); } catch (_) {}
    item.displayName = newFull;
    renderRows();
    U().toast('success', `Di-rename → ${newFull}`);
    if (S().backendOnline) App.api.tmpRename(oldFull, newFull);
  }

  async function removeFile(i) {
    const item = S().files[i];
    if (!item) return;
    const ok = await U().confirmDialog({
      title: 'Hapus file ini?',
      text: displayNameFor(item),
      confirmText: 'Hapus', danger: true,
    });
    if (!ok) return;
    const fname = item.displayName || item.file.name;
    S().files.splice(i, 1);
    renderRows();
    if (!S().files.length) {
      E().fileList.style.display = 'none';
      E().prevBtn.disabled = true; E().convBtn.disabled = true;
    }
    if (S().backendOnline) App.api.tmpDelete(fname);
  }

  async function clearAll() {
    if (!S().files.length) return;
    const ok = await U().confirmDialog({
      title: 'Hapus semua file?',
      text: `${S().files.length} file akan dihapus dari daftar & folder tmp/ di server.`,
      confirmText: 'Hapus Semua', danger: true,
    });
    if (!ok) return;
    App.audio.stopPreview();
    S().files.length = 0;
    renderRows();
    E().fileList.style.display = 'none';
    E().prevBtn.disabled = true; E().convBtn.disabled = true;
    E().status.textContent = ''; E().progWrap.style.display = 'none';
    if (S().backendOnline) App.api.tmpClear();
    U().toast('success', 'Semua file dihapus');
  }

  // ── tmp restore on reload ──
  async function loadTmpFiles() {
    if (!S().backendOnline) return;
    try {
      const j = await App.api.tmpList();
      let added = 0;
      for (const f of (j.files || [])) {
        if (S().files.some(x => x.file.name === f.name && x.file.size === f.size)) continue;
        try {
          const br = await App.api.tmpFile(f.name);
          if (!br.ok) continue;
          const blob = await br.blob();
          const file = new File([blob], f.name, { type: blob.type || 'audio/mpeg' });
          S().files.push(newItem(file, f.name));
          added++;
        } catch (_) {}
      }
      if (added) { renderRows(); markListVisible(); U().toast('info', `${added} file dimuat ulang dari tmp/`); }
    } catch (e) { console.warn('loadTmp failed', e); }
  }

  return {
    addFiles, addFileFromBlob, renameFile, removeFile, clearAll,
    loadTmpFiles, renderRows, updateConvButton, updateRowProgress, updateRowMeta,
    displayNameFor, outNameFor, moderationLabel,
  };
})();
