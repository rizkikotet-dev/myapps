/* ============================================================
   audio.js — AudioContext, preview, konversi OGG + header hack
   ============================================================ */
window.App = window.App || {};

App.audio = (() => {
  const S = () => App.state;
  const U = () => App.utils;
  const E = () => App.el;

  function getCtx() {
    if (!S().actx) S().actx = new (window.AudioContext || window.webkitAudioContext)();
    return S().actx;
  }

  // ── CRC32 OGG ──
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let s = i << 24;
    for (let j = 0; j < 8; j++) s = (s & 0x80000000) ? (s << 1) ^ 0x04c11db7 : (s << 1);
    crcTable[i] = s;
  }
  function computeOggCrc(arr, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) crc = (crc << 8) ^ crcTable[((crc >>> 24) ^ arr[i]) & 0xff];
    return crc >>> 0;
  }

  // ── preview ──
  function stopPreview() {
    if (S().prevSrc) { try { S().prevSrc.stop(); } catch (_) {} S().prevSrc = null; }
    if (S().fallbackAudio) { try { S().fallbackAudio.pause(); S().fallbackAudio.src = ''; } catch (_) {} S().fallbackAudio = null; }
    S().prevGain = null; S().isPrev = false;
    E().prevBtn.innerHTML = '<i class="ti ti-player-play"></i> Preview';
  }

  async function previewFallback(file, speed, db) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      S().fallbackAudio = audio;
      audio.playbackRate = speed;
      audio.volume = Math.max(0, Math.min(1, Math.pow(10, db / 20)));
      audio.onended = () => { URL.revokeObjectURL(url); if (S().isPrev) { stopPreview(); E().status.textContent = 'Preview selesai.'; } resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Fallback gagal: format tidak didukung')); };
      audio.play().then(() => {
        S().isPrev = true; E().prevBtn.disabled = false;
        E().prevBtn.innerHTML = '<i class="ti ti-player-stop"></i> Stop';
        E().status.textContent = `Preview fallback @ ${speed.toFixed(2)}× (mode <audio>)`;
      }).catch(reject);
    });
  }

  window.togglePreview = async function () {
    if (S().isPrev) { stopPreview(); E().status.textContent = 'Preview dihentikan.'; return; }
    if (!S().files.length) return;
    E().prevBtn.disabled = true;
    E().status.textContent = 'Memuat preview…';
    const file = S().files[0].file;
    const speed = parseFloat(E().spd.value);
    const db = parseFloat(E().dbs.value);
    try {
      const ctx = getCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      const ab = await file.arrayBuffer();
      let buf;
      try {
        buf = await ctx.decodeAudioData(ab.slice(0));
      } catch (decodeErr) {
        console.warn('decode gagal, fallback <audio>', decodeErr);
        await previewFallback(file, speed, db);
        return;
      }
      S().prevGain = ctx.createGain();
      S().prevGain.gain.value = Math.pow(10, db / 20);
      S().prevSrc = ctx.createBufferSource();
      S().prevSrc.buffer = buf;
      S().prevSrc.playbackRate.value = speed;
      S().prevSrc.connect(S().prevGain); S().prevGain.connect(ctx.destination);
      S().prevSrc.start();
      S().isPrev = true; E().prevBtn.disabled = false;
      E().prevBtn.innerHTML = '<i class="ti ti-player-stop"></i> Stop';
      const inv = (1 / speed).toFixed(3);
      E().status.textContent = `Preview @ ${speed.toFixed(2)}× — di Studio pakai PlaybackSpeed ${inv}`;
      S().prevSrc.onended = () => { if (S().isPrev) { stopPreview(); E().status.textContent = 'Preview selesai.'; } };
    } catch (e) {
      console.error('preview error', e);
      U().toast('error', 'Preview gagal: ' + e.message);
      E().status.textContent = 'Error preview: ' + e.message;
      E().prevBtn.disabled = false;
    }
  };

  // ── batas Roblox & pemecahan part ──
  const PART_MAX_EFF_SEC = 410;   // margin aman di bawah batas Roblox 7:00 (durasi efektif)
  const SIZE_MAX_BYTES = 20 * 1024 * 1024;

  // Durasi efektif yg dilihat Roblox = samples/(sr*speed) akibat header-hack sample rate.
  function computePartRanges(totalSamples, sampleRate, speed) {
    const spp = Math.round(sampleRate * speed * PART_MAX_EFF_SEC);
    if (totalSamples <= spp) return [{ start: 0, end: totalSamples }];
    const ranges = [];
    for (let s = 0; s < totalSamples; s += spp) {
      ranges.push({ start: s, end: Math.min(s + spp, totalSamples) });
    }
    return ranges;
  }

  function partNames(base, count) {
    return Array.from({ length: count }, (_, i) => count === 1
      ? { fileName: base + '.ogg', displayName: base }
      : { fileName: `${base} - Part${i + 1}.ogg`, displayName: `${base} - Part${i + 1}` });
  }

  // ── konversi inti ──
  async function convertOne(item, speed, gainLinear, quality) {
    const ctx = getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const ab = await item.file.arrayBuffer();
    let buf;
    try {
      buf = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      throw new Error(`Gagal decode ${item.file.name} (${item.file.type || 'unknown'}). Solusi: install ffmpeg agar backend transcode mp3, atau yt-dlp -x --audio-format mp3 "URL".`);
    }

    const nCh = buf.numberOfChannels;
    const originalSr = buf.sampleRate;

    // Langkah 1: gain render pada sample-rate asli
    const offCtx = new OfflineAudioContext(nCh, buf.length, originalSr);
    const src = offCtx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = 1.0;
    const gn = offCtx.createGain();
    gn.gain.value = gainLinear;
    src.connect(gn); gn.connect(offCtx.destination);
    src.start(0);
    const rendered = await offCtx.startRendering();

    const channels = [];
    for (let c = 0; c < nCh; c++) channels.push(rendered.getChannelData(c));

    // Langkah 2: encode OGG Vorbis
    const enc = await WasmMediaEncoder.createOggEncoder();
    enc.configure({ sampleRate: originalSr, channels: nCh, vbrQuality: quality / 9 });

    const CHUNK = 4096;
    const oggParts = [];
    for (let offset = 0; offset < rendered.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, rendered.length);
      const out = enc.encode(channels.map(ch => ch.subarray(offset, end)));
      if (out.length) oggParts.push(new Uint8Array(out));
    }
    const fin = enc.finalize();
    if (fin.length) oggParts.push(new Uint8Array(fin));

    const totalLen = oggParts.reduce((s, p) => s + p.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const p of oggParts) { merged.set(p, off); off += p.length; }

    // Langkah 3: header hack — sample rate * speed + CRC32
    const pageSegments = merged[26];
    let packetLength = 0;
    for (let s = 0; s < pageSegments; s++) packetLength += merged[27 + s];
    const pageSize = 27 + pageSegments + packetLength;
    const packetStart = 27 + pageSegments;

    if (merged[0] === 0x4f && merged[1] === 0x67 && merged[2] === 0x67 && merged[3] === 0x53 &&
        merged[packetStart] === 0x01 && merged[packetStart + 1] === 0x76 && merged[packetStart + 2] === 0x6f) {
      const targetSr = Math.round(originalSr * speed);
      merged[packetStart + 12] = targetSr & 0xff;
      merged[packetStart + 13] = (targetSr >>> 8) & 0xff;
      merged[packetStart + 14] = (targetSr >>> 16) & 0xff;
      merged[packetStart + 15] = (targetSr >>> 24) & 0xff;
      merged[22] = 0; merged[23] = 0; merged[24] = 0; merged[25] = 0;
      const newCrc = computeOggCrc(merged, 0, pageSize);
      merged[22] = newCrc & 0xff;
      merged[23] = (newCrc >>> 8) & 0xff;
      merged[24] = (newCrc >>> 16) & 0xff;
      merged[25] = (newCrc >>> 24) & 0xff;
    }

    return new Blob([merged], { type: 'audio/ogg' });
  }

  window.convertAll = async function () {
    if (!S().files.length) return;
    stopPreview();
    E().convBtn.disabled = true; E().prevBtn.disabled = true;
    E().progWrap.style.display = 'block';

    const speed = parseFloat(E().spd.value);
    const gain = Math.pow(10, parseFloat(E().dbs.value) / 20);
    const quality = parseInt(E().qslider.value);
    const autoMode = E().autoUploadCheck?.checked && S().isRobloxLogged && S().backendOnline;
    let doneCount = 0, failCount = 0;

    for (let i = 0; i < S().files.length; i++) {
      const item = S().files[i];
      item.status = 'proc'; App.files.renderRows();
      E().progLabel.textContent = `${i + 1}/${S().files.length}: ${App.files.displayNameFor(item)}`;
      const pct = Math.round((i / S().files.length) * 100);
      E().progPct.textContent = pct + '%';
      E().progFill.style.width = pct + '%';
      await new Promise(r => setTimeout(r, 20));
      try {
        const blob = await convertOne(item, speed, gain, quality);
        const outName = App.files.outNameFor(item);
        if (autoMode) {
          // Auto Upload: hasil TIDAK disimpan di server & TIDAK diunduh — langsung ke Roblox
        } else {
          // Mode manual: unduh ke folder Downloads milik user (bukan disimpan di server)
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = outName;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a); URL.revokeObjectURL(url);
        }
        try { await App.roblox.uploadToRoblox(blob, outName, outName.replace(/\.ogg$/, ''), item); }
        catch (e) { console.warn('auto upload skip', e); }
        item.status = 'done'; doneCount++;
      } catch (e) {
        item.status = 'err'; failCount++;
        console.error(item.file.name, e);
        U().errorDialog({
          title: 'Konversi gagal',
          text: String(e.message).slice(0, 400),
          footer: 'File lain tetap diproses. Detail lengkap ada di console (F12).',
        }).catch(() => {});
      }
      App.files.renderRows();
    }

    E().progLabel.textContent = 'Selesai!';
    E().progPct.textContent = '100%';
    E().progFill.style.width = '100%';
    setTimeout(() => { E().progWrap.style.display = 'none'; }, 2500);

    const inv = (1 / speed).toFixed(3);
    if (doneCount && !autoMode && !failCount) {
      U().toast('success', `${doneCount} file OGG terunduh ke perangkat`);
      E().status.textContent = `✓ ${doneCount}/${S().files.length} tersimpan di folder Downloads kamu · Putar di ${inv}× di Studio untuk suara asli`;
    } else if (doneCount && autoMode) {
      E().status.textContent = `✓ ${doneCount}/${S().files.length} dikonversi & di-upload ke Roblox (Auto Upload — tidak ada file lokal/server).`;
    }
    if (failCount) U().toast('warning', `${failCount} file gagal — lihat dialog error`);
    E().convBtn.disabled = false; E().prevBtn.disabled = false;
  };

  return { getCtx, stopPreview, convertOne, computePartRanges, partNames, PART_MAX_EFF_SEC, SIZE_MAX_BYTES };
})();
