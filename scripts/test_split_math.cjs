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
