# Roblox Audio Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memecah audio hasil konversi yang melebihi batas Roblox (<20MB, <7 menit efektif) menjadi beberapa part OGG (`Nama - Part1.ogg`, …), meng-upload berurutan, dan menyajikan dialog ringkasan Asset ID siap-copy.

**Architecture:** Semua di sisi frontend. Split terjadi pada AudioBuffer PCM hasil decode di `js/audio.js` sebelum encode OGG — tiap part di-encode dan dapat header-hack sample-rate sendiri. Alur upload/unduh existing dipakai ulang per part; dialog ringkasan memakai SweetAlert2 yang sudah ada.

**Tech Stack:** Vanilla JS (window.App namespaces), Web Audio API, WasmMediaEncoder (OGG Vorbis, sudah ada), SweetAlert2 (sudah ada), Node (hanya untuk self-check fungsi murni), Python stdlib (generator WAV uji).

**Spec:** `docs/compose/specs/2026-08-25-roblox-audio-split-design.md`

## Global Constraints

- TANPA dependensi baru (npm/python/wasm). Hanya kode di `js/`, `css/app.css`, dan script uji di `scripts/`.
- Konstanta tetap: `PART_MAX_EFF_SEC = 410` (detik efektif), `SIZE_MAX_BYTES = 20 * 1024 * 1024`.
- Penamaan persis: `` `${base} - Part${i+1}.ogg` `` untuk fileName dan `${base} - Part${i+1}` untuk displayName; hanya jika jumlah part > 1.
- File single-part: perilaku & nama TIDAK berubah sama sekali (tanpa akhiran "Part", tanpa dialog).
- Jangan ubah kontrak `POST /api/roblox/upload` maupun `js/api.js`.
- Copy UI dalam bahasa Indonesia.
- Setiap selesai mengubah frontend, jalankan `python scripts/sync_dist.py` sebelum uji desktop/Tauri (uji browser murni tidak perlu).
- Satu commit per task, pesan bahasa Indonesia/Inggris bebas konsisten dengan gaya repo (lihat `git log --oneline`: lowercase, imperative).

## Latar konteks untuk implementer (baca dulu)

- `js/audio.js` `convertOne()` (baris ~95-164): decode → OfflineAudioContext gain render → encode OGG chunk 4096 sampel via `WasmMediaEncoder` → header hack (patch sample rate `originalSr * speed` + CRC32 halaman pertama).
- **Durasi efektif** yang dilihat Roblox = `samples / (sampleRate × speed)` karena header hack. Speed default slider 2.3× (`index.html #spd`), range 0.5–4.0.
- `js/audio.js` `convertAll()`: loop per file; `autoMode` = checkbox auto-upload aktif && login && backend online. Manual → unduh via anchor click; Auto → `App.roblox.uploadToRoblox(blob, filename, displayName, item)`.
- `js/roblox.js`: `uploadToRoblox` set `item.roblox={status,...}` lalu `App.api.robloxUpload(...)` + polling operasi/moderasi; state baris dirender dari `item.roblox` oleh `js/files.js` (`rblxBadge`, `rInfoHtml`, `rowProgressHtml`).
- Dialog: SweetAlert2 global `Swal`; helper bertema di `js/utils.js` (`base()` internal — akan diekspor).
- Frontend bisa diuji di browser biasa lewat server python lokal (menyajikan ROOT): `python server.py --port 8000` → http://127.0.0.1:8000/ . Desktop butuh `sync_dist.py`.
- Test node memuat `js/audio.js` aman karena top-level hanya mendefinisikan fungsi (tidak ada akses DOM/WASM di top-level).

---

### Task 1: Fungsi murni pemecahan + penamaan (TDD via Node)

**Covers:** [S3], [S4]

**Files:**
- Modify: `js/audio.js` (tambah 2 fungsi murni di atas `convertOne`, ekspor di return)
- Create: `scripts/test_split_math.cjs`

**Interfaces:**
- Consumes: (tidak ada — task awal)
- Produces:
  - `App.audio.computePartRanges(totalSamples: int, sampleRate: int, speed: number) -> [{start: int, end: int}]`
  - `App.audio.partNames(base: string, count: int) -> [{fileName: string, displayName: string}]`
  - Konstanta `App.audio.PART_MAX_EFF_SEC = 410`, `App.audio.SIZE_MAX_BYTES = 20971520` (dipakai Task 2)

- [ ] **Step 1: Tulis self-check yang gagal**

Create `scripts/test_split_math.cjs`:

```js
// Self-check murni-matematika untuk split audio (tanpa browser).
// Jalankan: node scripts/test_split_math.cjs
global.window = global;
new Function(require('fs').readFileSync('js/audio.js', 'utf8'))();
const A = window.App.audio;
const assert = require('assert');
const SR = 44100;

// 1) file pendek (3 menit, speed 1x) -> 1 part penuh
let r = A.computePartRanges(180 * SR, SR, 1);
assert.strictEqual(r.length, 1);
assert.deepStrictEqual(r[0], { start: 0, end: 180 * SR });

// 2) tepat 410s -> tetap 1 part
r = A.computePartRanges(410 * SR, SR, 1);
assert.strictEqual(r.length, 1);

// 3) 8 menit @1x -> 2 part isi-maksimal
r = A.computePartRanges(480 * SR, SR, 1);
assert.strictEqual(r.length, 2);
assert.deepStrictEqual(r[0], { start: 0, end: Math.round(SR * 410) });
assert.deepStrictEqual(r[1], { start: Math.round(SR * 410), end: 480 * SR });

// 4) 14 menit @2x -> efektif 7 menit > 410s -> 2 part
const spp = Math.round(SR * 2 * 410);
r = A.computePartRanges(14 * 60 * SR, SR, 2);
assert.strictEqual(r.length, 2);
assert.deepStrictEqual(r[1], { start: spp, end: 14 * 60 * SR });

// 5) 14 menit @2.3x -> efektif ~6.09 menit <= 410s -> 1 part
r = A.computePartRanges(14 * 60 * SR, SR, 2.3);
assert.strictEqual(r.length, 1);

// 6) speed < 1 memperpanjang durasi efektif: 6 menit @0.5x -> efektif 12 menit -> 2 part
r = A.computePartRanges(6 * 60 * SR, SR, 0.5);
assert.strictEqual(r.length, 2);

// 7) penamaan
let n = A.partNames('Lagu', 1);
assert.deepStrictEqual(n, [{ fileName: 'Lagu.ogg', displayName: 'Lagu' }]);
n = A.partNames('Lagu', 3);
assert.deepStrictEqual(n.map(x => x.fileName), ['Lagu - Part1.ogg', 'Lagu - Part2.ogg', 'Lagu - Part3.ogg']);
assert.strictEqual(n[1].displayName, 'Lagu - Part2');

console.log('OK: split math + naming benar');
```

- [ ] **Step 2: Jalankan untuk melihat gagal**

Run: `node scripts/test_split_math.cjs`
Expected: FAIL — `TypeError: A.computePartRanges is not a function`

- [ ] **Step 3: Implementasi minimal**

Di `js/audio.js`, tepat di atas komentar `// ── konversi inti ──`, tambah:

```js
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
```

Ubah baris return modul (paling bawah IIFE) menjadi:

```js
  return { getCtx, stopPreview, convertOne, computePartRanges, partNames, PART_MAX_EFF_SEC, SIZE_MAX_BYTES };
```

- [ ] **Step 4: Jalankan lagi hingga lolos**

Run: `node scripts/test_split_math.cjs`
Expected: `OK: split math + naming benar`, exit code 0

- [ ] **Step 5: Commit**

```bash
git add js/audio.js scripts/test_split_math.cjs
git commit -m "feat: fungsi murni pemecahan part audio sesuai batas roblox"
```

---

### Task 2: Refactor convertOne → multi-part encode

**Covers:** [S5]

**Files:**
- Modify: `js/audio.js:95-164` (badan `convertOne`)

**Interfaces:**
- Consumes: `computePartRanges`, `partNames`, `PART_MAX_EFF_SEC`, `SIZE_MAX_BYTES` (Task 1); `WasmMediaEncoder` global (existing)
- Produces:
  - `convertOne(item, speed, gainLinear, quality) -> Promise<Array<{blob: Blob, fileName: string, displayName: string}>>` — **return type berubah dari Blob menjadi array**; panjang 1 untuk file tak dipecah.

- [ ] **Step 1: Refactor badan convertOne**

Ganti seluruh badan `async function convertOne(...)` (setelah bagian decode + gain render yang TETAP) menjadi struktur berikut. Bagian "Langkah 1" (OfflineAudioContext gain render, baris existing ~109-120) tidak berubah; lanjutannya diganti:

```js
    const channels = [];
    for (let c = 0; c < nCh; c++) channels.push(rendered.getChannelData(c));

    function mergeBytes(partsArr) {
      const totalLen = partsArr.reduce((s, p) => s + p.length, 0);
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const p of partsArr) { merged.set(p, off); off += p.length; }
      return merged;
    }

    // Langkah 2+3 lama, kini per rentang: encode OGG + header hack sample-rate.
    async function encodeRange(startSample, endSample) {
      const enc = await WasmMediaEncoder.createOggEncoder();
      enc.configure({ sampleRate: originalSr, channels: nCh, vbrQuality: quality / 9 });
      const CHUNK = 4096;
      const oggParts = [];
      for (let offset = startSample; offset < endSample; offset += CHUNK) {
        const end = Math.min(offset + CHUNK, endSample);
        const out = enc.encode(channels.map(ch => ch.subarray(offset, end)));
        if (out.length) oggParts.push(new Uint8Array(out));
      }
      const fin = enc.finalize();
      if (fin.length) oggParts.push(new Uint8Array(fin));
      const merged = mergeBytes(oggParts);

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

    // Pengaman ukuran: part >20MB (kualitas ekstrem) dipecah dua & encode ulang.
    async function encodePartWithGuard(startSample, endSample, depth) {
      const blob = await encodeRange(startSample, endSample);
      if (blob.size > SIZE_MAX_BYTES && depth < 2 && (endSample - startSample) > sampleRate) {
        const mid = (startSample + endSample) >> 1;
        return [
          ...await encodePartWithGuard(startSample, mid, depth + 1),
          ...await encodePartWithGuard(mid, endSample, depth + 1),
        ];
      }
      return [blob];
    }

    const ranges = computePartRanges(rendered.length, originalSr, speed);
    let blobs = [];
    for (const r of ranges) blobs = blobs.concat(await encodePartWithGuard(r.start, r.end, 0));

    const base = (item.displayName || item.file.name).replace(/\.[^/.]+$/, '');
    const names = partNames(base, blobs.length);
    return blobs.map((blob, i) => ({ blob, ...names[i] }));
```

Hapus blok lama "Langkah 2"/"Langkah 3" dan `return new Blob(...)` tunggal yang sudah dipindah ke atas.

- [ ] **Step 2: Verifikasi sintaks & regresi matematika**

Run: `node scripts/test_split_math.cjs`
Expected: `OK: split math + naming benar` (memastikan file tetap valid & fungsi Task 1 utuh)

- [ ] **Step 3: Smoke test browser — single-part tak berubah**

Jalankan `python server.py --port 8000` (workdir root proyek), buka http://127.0.0.1:8000/ , add file audio pendek (<3 menit), speed bebas, klik Konversi (mode unduh).
Expected: 1 file terunduh bernama `<nama>.ogg` TANPA akhiran Part; terputar normal. (Perilaku lama.)

- [ ] **Step 4: Commit**

```bash
git add js/audio.js
git commit -m "feat: convertOne menghasilkan multi-part ogg dengan guard 20mb"
```

---

### Task 3: Wiring convertAll + uploadParts per-part

**Covers:** [S6]

**Files:**
- Modify: `js/audio.js:166-228` (`convertAll` blok per-file)
- Modify: `js/roblox.js:180-245` (`uploadToRoblox` preserve state + wrapper baru `uploadParts`)
- Modify: `js/files.js:21-39` (`rblxBadge` tampilkan partLabel)

**Interfaces:**
- Consumes: array hasil `convertOne` (Task 2); `App.api.robloxUpload` (unchanged)
- Produces:
  - `App.roblox.uploadParts(item, parts) -> Promise<Array<{name, assetId, status, moderation, error}>>`
  - State baris: `item.roblox.parts: [{name, assetId, status, moderation, error}]`, `item.roblox.partLabel: string` (mis. `"Part 2/3"`)
  - `App.roblox.showPartsSummary(item)` (dideklarasikan Task 4; di Task 3 boleh stub no-op agar tidak ReferenceError)

- [ ] **Step 1: Preserve state di uploadToRoblox (roblox.js)**

Di dalam `uploadToRoblox`, ganti dua assignment yang menimpa objek:

```js
    if (item) {
      item.roblox = { ...(item.roblox || {}), status: 'uploading', msg: 'Uploading…', progress: 0 };
      App.files.renderRows();
    }
```

dan pada catch:

```js
      if (item) { item.roblox = { ...(item.roblox || {}), status: 'error', error: e.message.slice(0, 220) }; App.files.renderRows(); }
```

(`pollRobloxOperation`/`pollRobloxAudit` sudah mutasi field, tidak menimpa objek — aman.)

Tambahkan wrapper + stub dialog di bawah `uploadToRoblox` (sebelum `return {...}`):

```js
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
      results.push(doneParts[doneParts.length - 1]);
    }
    return results;
  }

  async function showPartsSummary(item) { /* Task 4 */ }
```

Update export modul roblox.js:

```js
  return { checkRoblox, setRobloxStatus, uploadToRoblox, uploadParts, showPartsSummary, pollRobloxOperation };
```

Catatan: gate `autoUploadCheck` di awal `uploadToRoblox` tetap ada — caller (convertAll) hanya memanggil saat autoMode sehingga gate lolos.

- [ ] **Step 2: Badge menampilkan label part (files.js)**

Di `rblxBadge`, setelah `const [cls, label] = map[r.status] || ...`, ganti baris label jadi:

```js
    const pl = r.partLabel ? r.partLabel + ' · ' : '';
    const text = pl + label;
```

dan gunakan `${U().escapeHtml(text)}${U().escapeHtml(extra)}` pada template span (ganti referensi `label`).

- [ ] **Step 3: convertAll pakai array part (audio.js)**

Ganti blok dari `const blob = await convertOne(...)` sampai akhir try (sebelum `item.status='done'`) dengan:

```js
        const partsOut = await convertOne(item, speed, gain, quality);
        if (autoMode) {
          // Auto Upload: semua part langsung ke Roblox — tanpa file lokal/server
          try {
            await App.roblox.uploadParts(item, partsOut);
            if (partsOut.length > 1) App.roblox.showPartsSummary(item);
          } catch (e) { console.warn('auto upload skip', e); }
        } else {
          // Mode manual: unduh tiap part ke Downloads
          for (const p of partsOut) {
            const url = URL.createObjectURL(p.blob);
            const a = document.createElement('a');
            a.href = url; a.download = p.fileName;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
            await new Promise(r => setTimeout(r, 350));
          }
        }
```

- [ ] **Step 4: Verifikasi sintaks + smoke browser**

Run: `node scripts/test_split_math.cjs` → `OK: ...`

Browser: `python server.py --port 8000`; buka UI; (a) mode unduh dengan file pendek → 1 unduhan nama lama; (b) file 8 menit (buat: `python -c "import wave,math,struct; f=wave.open('tmp/e2e-8min.wav','w'); f.setnchannels(2); f.setsampwidth(2); f.setframerate(44100); [f.writeframes(b''.join(struct.pack('<hh', int(9000*math.sin(2*math.pi*440*t/44100)), int(9000*math.sin(2*math.pi*440*t/44100)))) for t in range(480*44100)])" ; f.close()` — atau simpan sebagai `scripts/gen_test_wav.py` bila lebih mudah) → set slider `#spd` ke `1.0` → Konversi → 2 unduhan `... - Part1.ogg` & `... - Part2.ogg`.

- [ ] **Step 5: Commit**

```bash
git add js/audio.js js/roblox.js js/files.js
git commit -m "feat: alur unduh & auto-upload multi-part dengan progres per part"
```

---

### Task 4: Dialog ringkasan ID

**Covers:** [S7]

**Files:**
- Modify: `js/utils.js:96` (ekspor `swalBase`)
- Modify: `js/roblox.js` (isi `showPartsSummary`)
- Modify: `css/app.css` (style tabel part)

**Interfaces:**
- Consumes: `item.roblox.parts` (Task 3); `Swal` global; `App.utils.copyText`
- Produces: `App.roblox.showPartsSummary(item) -> void` (fire-and-forget dialog)

- [ ] **Step 1: Ekspor swalBase (utils.js)**

Ubah return utils.js:

```js
  return { fmtSize, sanitizeFilename, ytDlpCommand, escapeHtml, copyText, toast, confirmDialog, inputDialog, errorDialog, debounce, swalBase: base };
```

- [ ] **Step 2: Isi showPartsSummary (roblox.js)** — ganti stub:

```js
  // Dialog ringkasan multi-part: tabel Part|Asset ID|Moderasi + copy rbxassetid list.
  function showPartsSummary(item) {
    const parts = (item.roblox && item.roblox.parts) || [];
    if (parts.length < 2) return;
    const rows = parts.map((p, i) =>
      `<tr><td>${i + 1}</td><td class="pt-name">${U().escapeHtml(p.name)}</td><td>${
        p.assetId ? '<code>rbxassetid://' + U().escapeHtml(p.assetId) + '</code>'
                  : '<span class="pt-fail">✗ ' + U().escapeHtml((p.error || 'gagal').slice(0, 60)) + '</span>'
      }</td></tr>`).join('');
    const idText = parts.filter(p => p.assetId).map(p => 'rbxassetid://' + p.assetId).join('\n');
    if (typeof Swal === 'undefined') { U().copyText(idText); return; }
    Swal.fire(U().swalBase({
      title: 'Upload Multi-Part Selesai',
      html: `<table class="parts-table"><thead><tr><th>#</th><th>Nama</th><th>Asset ID</th></tr></thead><tbody>${rows}</tbody></table>
             <p class="parts-hint">Susun ID di atas berurutan di Roblox Studio (audio playlist / crossfade) agar penyambungannya mulus.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Copy ID',
      cancelButtonText: 'Tutup',
      reverseButtons: true,
      preConfirm: () => { U().copyText(idText); return false; },
    }));
  }
```

(`return false` di preConfirm menjaga dialog tetap terbuka; tutup via Tombol Tutup/Esc.)

- [ ] **Step 3: CSS (css/app.css, tambah di akhir)**

```css
/* Dialog ringkasan upload multi-part */
.parts-table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .25rem; }
.parts-table th, .parts-table td { padding: .35rem .5rem; border-bottom: 1px solid rgba(128,128,128,.25); text-align: left; word-break: break-all; }
.parts-table th { font-weight: 600; opacity: .75; }
.pt-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-fail { color: #dc2626; font-weight: 600; }
.parts-hint { font-size: .8rem; opacity: .7; margin-top: .6rem; text-align: left; }
```

- [ ] **Step 4: Verifikasi visual tanpa upload nyata**

Browser di http://127.0.0.1:8000/ , DevTools console:

```js
App.state.files.push({ uid:'t1', file:{name:'demo.mp3'}, displayName:'Demo Lagu', status:'done',
  roblox:{ status:'done', parts:[
    {name:'Demo Lagu - Part1', assetId:'1111111111', status:'done', moderation:'MODERATION_STATE_APPROVED'},
    {name:'Demo Lagu - Part2', assetId:'', status:'error', error:'simulasi gagal'},
    {name:'Demo Lagu - Part3', assetId:'2222222222', status:'done', moderation:''},
  ], partLabel:'' }});
App.roblox.showPartsSummary(App.state.files.at(-1));
```

Expected: dialog tabel 3 baris (part2 merah ✗), klik **Copy ID** → toast "Disalin ke clipboard"; paste di editor = dua baris `rbxassetid://1111111111` dan `rbxassetid://2222222222`. Tutup dialog berfungsi.

Run juga: `node scripts/test_split_math.cjs` → masih OK.

- [ ] **Step 5: Commit**

```bash
git add js/utils.js js/roblox.js css/app.css
git commit -m "feat: dialog ringkasan asset id multi-part dengan copy"
```

---

### Task 5: Verifikasi E2E lokal (spec S8) + sync dist

**Covers:** [S8]

**Files:**
- Create (opsional, jika belum dibuat di Task 3 Step 4): `scripts/gen_test_wav.py`

**Interfaces:**
- Consumes: seluruh fitur selesai (Task 1-4)
- Produces: bukti verifikasi tercatat di percakapan/laporan; tidak ada perubahan perilaku

- [ ] **Step 1: Generator WAV uji**

Create `scripts/gen_test_wav.py`:

```python
#!/usr/bin/env python3
"""Generate WAV sine stereo utk uji split. Jalankan: python scripts/gen_test_wav.py [durasi_detik]"""
import math, struct, sys, wave
dur = int(sys.argv[1]) if len(sys.argv) > 1 else 480
with wave.open("tmp/e2e-split.wav", "w") as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(44100)
    frames = (struct.pack("<hh", int(9000 * math.sin(2 * math.pi * 440 * t / 44100)),
                          int(9000 * math.sin(2 * math.pi * 440 * t / 44100)))
              for t in range(dur * 44100))
    f.writeframes(b"".join(frames))
print(f"ok tmp/e2e-split.wav {dur}s")
```

Run: `python scripts/gen_test_wav.py 480` → Expected: `ok tmp/e2e-split.wav 480s`

- [ ] **Step 2: Server lokal + browser**

Start `python server.py --port 55777` (background). Buka http://127.0.0.1:55777/ via playwright skill (atau manual + instruksi user). Langkah:
1. `setInputFiles('#fi', 'tmp/e2e-split.wav')`
2. Set slider: `page.locator('#spd').fill('1')` (eval `document.getElementById('spd').value=1; document.getElementById('spd').dispatchEvent(new Event('input'))`)
3. Klik `#conv-btn` (mode unduh manual — pastikan checkbox auto-upload OFF bila ada)
4. Tangkap event download playwright

Expected: tepat 2 download bernama `e2e-split - Part1.ogg`, `e2e-split - Part2.ogg`

- [ ] **Step 3: Validasi hasil**

```bash
python -c "
from mutagen.oggvorbis import OggVorbis
for n in ('tmp/e2e-split - Part1.ogg','tmp/e2e-split - Part2.ogg'):
    import os; p=os.path.join('tmp',n); a=OggVorbis(p)
    import os.path as o
    print(n, round(a.info.length,2),'s', o.getsize(p)//1024,'KB')
    assert a.info.length<=412 and o.getsize(p)<20*1024*1024
print('VALID')"
```
Expected: Part1 ≈ 410s, Part2 ≈ 70s, keduanya `VALID`.

(Catatan: mutagen tersedia via dependensi yt-dlp; bila absen: `pip install mutagen` — dev-dependency lokal, bukan dep proyek.)

- [ ] **Step 4: Sync dist untuk build desktop**

Run: `python scripts/sync_dist.py`
Expected: `[sync-dist] ok -> ...\src-tauri\dist`

- [ ] **Step 5: Bersihkan artefak uji**

```bash
Remove-Item "tmp\e2e-split*.ogg","tmp\e2e-split.wav" -ErrorAction SilentlyContinue
```

(Tidak ada commit — task verifikasi. Bila ada bug ditemukan: perbaiki di file terkait, ulangi langkah yang relevan, commit fix terpisah.)
