/* ============================================================
   urlfetch.js — ambil audio dari YouTube / SoundCloud via yt-dlp
   ============================================================ */
window.App = window.App || {};

App.urlfetch = (() => {
  const S = () => App.state;
  const U = () => App.utils;
  const E = () => App.el;

  const sourceHint = (url) =>
    /youtu\.be|youtube\.com/i.test(url) ? 'YouTube'
    : /soundcloud\.com/i.test(url) ? 'SoundCloud' : 'URL';

  function setStatus(msg, kind) {
    E().urlStatus.textContent = msg;
    E().urlStatus.className = kind || '';
  }

  function showFallbackCommand(url, prefixMsg) {
    const cmd = U().ytDlpCommand(url);
    setStatus(prefixMsg, 'err');
    const code = document.createElement('code');
    code.className = 'fallback-code';
    code.textContent = cmd;
    code.title = 'Klik untuk copy';
    code.addEventListener('click', () => U().copyText(cmd));
    E().urlStatus.appendChild(document.createElement('br'));
    E().urlStatus.appendChild(code);
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:.4rem;color:var(--text2)';
    tip.textContent = 'Lalu drag file hasil download ke zona upload di atas.';
    E().urlStatus.appendChild(tip);
  }

  async function handlePlaylist(j) {
    const entries = j.entries || [];
    for (const e of entries) {
      if (!e.download_url) continue;
      setStatus(`Mengunduh: ${e.title} …`, '');
      try {
        const fr = await fetch(App.api.fetchRelative(e.download_url));
        if (fr.ok) {
          const b = await fr.blob();
          App.files.addFileFromBlob(b, `${e.title || 'track'}.${e.ext || 'mp3'}`);
        }
      } catch (err) { console.warn('playlist entry gagal', e.title, err); }
    }
    setStatus(`✓ ${entries.length} track diproses — siap konversi.`, 'ok');
    U().toast('success', `${entries.length} track dari playlist ditambahkan`);
    E().urlInput.value = '';
  }

  async function handleSingle(resp, url) {
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition');
    let filename = 'audio.mp3';
    const m = cd && /filename="?([^"]+)"?/i.exec(cd);
    if (m) filename = m[1];
    if (blob.size < 1024) throw new Error('File terlalu kecil — mungkin URL private / age-restricted');

    // guard: HTML/error page salah kirim sebagai audio
    const head = (await blob.slice(0, 1024).text()).trim().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{"error"')) {
      throw new Error('Backend mengembalikan error/HTML, bukan audio: ' + head.slice(0, 160));
    }

    App.files.addFileFromBlob(blob, filename);
    setStatus(`✓ ${sourceHint(url)} ditambahkan: ${filename} (${U().fmtSize(blob.size)}) — siap konversi!`, 'ok');
    U().toast('success', `${filename} siap dikonversi`);
    E().urlInput.value = '';
  }

  window.fetchFromUrl = async function () {
    const raw = E().urlInput.value.trim();
    if (!raw) { setStatus('Paste link YouTube / SoundCloud dulu.', 'err'); return; }
    let url;
    try { url = new URL(raw).toString(); } catch { setStatus('URL tidak valid.', 'err'); return; }

    const hint = sourceHint(url);

    if (!S().backendOnline) await App.boot.checkBackend();

    // ── backend offline → fallback command ──
    if (!S().backendOnline) {
      E().urlStatus.className = 'status-line err';
      E().urlStatus.innerHTML =
        `Backend belum jalan — untuk <b>${hint}</b>, jalankan perintah ini lalu drag hasilnya ke zona upload:`;
      const code = document.createElement('code');
      code.className = 'fallback-code';
      code.textContent = U().ytDlpCommand(url);
      code.title = 'Klik untuk copy';
      code.addEventListener('click', () => U().copyText(code.textContent));
      E().urlStatus.appendChild(code);
      U().toast('info', 'Backend offline — perintah manual siap disalin');
      return;
    }

    // ── backend online ──
    E().urlBtn.disabled = true;
    setStatus(`Mengambil ${hint} via yt-dlp…`, '');
    try {
      const resp = await App.api.downloadFromUrl(url);
      const ct = resp.headers.get('Content-Type') || '';
      if (ct.includes('application/json')) {
        const j = await resp.json();
        if (j.entries && Array.isArray(j.entries)) {
          setStatus(`Playlist terdeteksi: ${j.entries.length} track — mengambil satu per satu…`, 'ok');
          await handlePlaylist(j);
          return;
        }
        throw new Error('Respons backend tidak dikenal');
      }
      await handleSingle(resp, url);
    } catch (err) {
      console.error(err);
      showFallbackCommand(url, `Gagal via backend: ${err.message}. Fallback manual →`);
      U().toast('error', `Gagal mengambil ${hint}`);
    } finally {
      E().urlBtn.disabled = false;
    }
  };

  return {};
})();
