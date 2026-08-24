/* ============================================================
   utils.js — helpers + SweetAlert2 dialogs/toasts
   ============================================================ */
window.App = window.App || {};

App.utils = (() => {
  const themeColors = () => {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark
      ? { bg: '#242429', text: '#f1f1f3', confirm: '#5b9bff' }
      : { bg: '#ffffff', text: '#17171a', confirm: '#2563eb' };
  };

  const base = (opts = {}) => {
    const c = themeColors();
    return Object.assign({
      background: c.bg,
      color: c.text,
      confirmButtonColor: c.confirm,
      customClass: { popup: 'swal2-rounded' },
    }, opts);
  };

  const Toast = typeof Swal !== 'undefined'
    ? Swal.mixin({
        toast: true, position: 'top-end', showConfirmButton: false,
        timer: 3200, timerProgressBar: true,
        didOpen: (t) => {
          t.addEventListener('mouseenter', Swal.stopTimer);
          t.addEventListener('mouseleave', Swal.resumeTimer);
        },
      })
    : null;

  function toast(icon, title) {
    if (!Toast) { console[icon === 'error' ? 'error' : 'log'](title); return; }
    Toast.fire({ icon, title });
  }

  async function confirmDialog({ title, text, confirmText = 'OK', danger = false } = {}) {
    if (typeof Swal === 'undefined') return window.confirm(text || title);
    const c = themeColors();
    const res = await Swal.fire(base({
      title, text, icon: 'question',
      showCancelButton: true,
      confirmButtonText: confirmText,
      cancelButtonText: 'Batal',
      confirmButtonColor: danger ? '#dc2626' : c.confirm,
      reverseButtons: true,
    }));
    return res.isConfirmed;
  }

  async function inputDialog({ title, text, value = '', placeholder = '' } = {}) {
    if (typeof Swal === 'undefined') return window.prompt(title, value);
    const c = themeColors();
    const res = await Swal.fire(base({
      title, text,
      input: 'text',
      inputValue: value,
      inputPlaceholder: placeholder,
      showCancelButton: true,
      confirmButtonText: 'Simpan',
      cancelButtonText: 'Batal',
      inputAttributes: { style: 'font-size:.9rem' },
      preConfirm: (v) => { if (!v || !v.trim()) { Swal.showValidationMessage('Nama tidak boleh kosong'); return false; } return v.trim(); },
    }));
    return res.isConfirmed ? res.value : null;
  }

  async function errorDialog({ title = 'Terjadi Kesalahan', text = '', footer = '' } = {}) {
    if (typeof Swal === 'undefined') { window.alert(text); return; }
    await Swal.fire(base({
      title, text, icon: 'error', footer,
      confirmButtonText: 'Mengerti',
      grow: 'row',
    }));
  }

  // ── misc helpers ──
  const fmtSize = (b) => b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';

  const sanitizeFilename = (name) => (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'audio';

  const ytDlpCommand = (url) => `yt-dlp -x --audio-format best -o "%(title)s.%(ext)s" "${String(url).replace(/"/g, '\\"')}"`;

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('success', 'Disalin ke clipboard'); }
    catch { toast('error', 'Gagal menyalin'); }
  };

  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  return { fmtSize, sanitizeFilename, ytDlpCommand, escapeHtml, copyText, toast, confirmDialog, inputDialog, errorDialog, debounce, swalBase: base };
})();
