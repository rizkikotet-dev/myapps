# Spec: Pemecahan Audio untuk Batas Upload Roblox

Tanggal: 2026-08-25
Status: disetujui (dialog brainstorm)

## [S1] Masalah
Roblox membatasi audio asset: ukuran < 20MB dan durasi < 7 menit. File hasil konversi yang melebihi salah satu batas ditolak saat upload. Pengguna harus memecah manual, meng-upload satu per satu, dan mencatat ID asset sendiri untuk digabung di Roblox Studio.

## [S2] Solusi ringkas
Konversi di browser (`js/audio.js`) dipecah menjadi beberapa part OGG saat file melebihi ambang. Tiap part di-upload sebagai asset terpisah dengan nama `Nama - Part1`, `Nama - Part2`, dst. Setelah semua part selesai, dialog ringkasan menampilkan semua Asset ID berurutan + tombol copy, sehingga pengguna tinggal menyusunnya berurutan di Roblox Studio.

## [S3] Aturan pemecahan
- Ambang part: **410 detik durasi efektif** (6:50, margin aman di bawah 7:00) dan **20MB** per part.
- Durasi efektif = `samples / (sampleRate × speed)` — durasi yang dilihat Roblox setelah trik sample-rate pada header OGG (`audio.js` langkah 3). File yang efektifnya ≤ 410s tidak dipecah meski durasi aslinya panjang.
- Jumlah part `N = ceil(durasiEfektifTotal / 410)`; part 1..N-1 selongkar penuh 410s, part terakhir berisi sisa (strategi isi-maksimal, bukan sama rata).
- Pengaman ukuran: jika blob sebuah part hasil encode > 20MB (kualitas ekstrem), rentang waktu part itu dipecah dua dan di-encode ulang, rekursif maksimal 2 level.
- File single-part: perilaku lama persis — nama tanpa akhiran, alur unduh/upload tak berubah.

## [S4] Penamaan
Base nama keluaran `Lagu` menghasilkan `Lagu - Part1.ogg`, `Lagu - Part2.ogg`, … displayName yang dikirim ke Roblox: `Lagu - Part1` (tanpa ekstensi).

## [S5] Perubahan konversi (`js/audio.js`)
- Langkah "encode OGG + header hack" dipindah ke helper `encodeRange(startSample, endSample, …)`; dipanggil sekali per part.
- Header hack dieksekusi per part karena tiap part adalah stream OGG baru dengan halaman pertamanya sendiri.
- `convertOne` mengembalikan array `[{blob, fileName, displayName}]` (panjang 1 untuk file yang tak dipecah).

## [S6] Alur unduh & upload
- Mode manual: semua part diunduh berurutan memakai mekanisme unduh existing.
- Mode auto-upload: `uploadToRoblox` dipanggil per part berurutan; polling operasi & moderasi memakai rantai existing per part.
- State baris file: `item.roblox.parts = [{name, assetId, status, moderation}]`, progres tampil sebagai `Part k/N — <aktivitas>`.
- Kegagalan satu part TIDAK menghentikan part berikutnya; part gagal ditandai error, sisanya lanjut.

## [S7] Dialog ringkasan
- Muncul hanya jika file dipecah (>1 part), setelah semua part selesai.
- Isi: tabel `Part | Asset ID | Status moderasi` + tombol **Copy ID**.
- Copy menyalin daftar `rbxassetid://<id>` satu per baris, urut nomor part, hanya part yang berhasil.

## [S8] Verifikasi
- E2E lokal tanpa upload nyata: generate WAV uji ~8 menit via script Python (`wave`, sine/silence), konversi lewat UI di browser terhadap server lokal, pastikan: jumlah part benar (≥2), penamaan sesuai [S4], tiap part <20MB, tiap OGG valid ter-decode dan durasi efektif tiap part ≤ 410s.
- Path upload tidak diubah secara fungsional; live-upload ke akun Roblox hanya atas permintaan eksplisit pengguna.
