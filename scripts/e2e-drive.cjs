// E2E driver: konversi WAV 8 menit di app, tangkap unduhan part, simpan ke tmp/.
// Jalankan dengan NODE_PATH menunjuk ke node_modules berisi playwright.
const { chromium } = require("playwright");

const ROOT = "C:/Users/rizkivalency/Desktop/myapps";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR " + e.message));
  await page.goto("http://127.0.0.1:55777/", { waitUntil: "load" });

  // mode manual: pastikan auto-upload off bila elemennya ada
  await page.evaluate(() => {
    document.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = false; });
  });

  await page.setInputFiles("#fi", ROOT + "/tmp/e2e-split.wav");

  // speed slider -> 1.0 agar durasi efektif = durasi asli (8 menit > 410s)
  await page.evaluate(() => {
    const s = document.getElementById("spd");
    s.value = "1";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const downloads = [];
  page.on("download", (d) => downloads.push(d));

  await page.click("#conv-btn");
  // convertAll me-nonaktifkan #conv-btn saat mulai & mengaktifkan lagi di akhir
  await page.waitForFunction(
    () => !!document.getElementById("conv-btn") && !document.getElementById("conv-btn").disabled,
    null,
    { timeout: 300000, polling: 1000 }
  );
  // tunggu event download selesai masuk
  await page.waitForTimeout(2000);

  const out = [];
  for (const d of downloads) {
    const fn = d.suggestedFilename();
    await d.saveAs(ROOT + "/tmp/" + fn);
    out.push(fn);
  }
  console.log("DOWNLOADS=" + JSON.stringify(out));
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("E2E-FAIL " + e.message);
  process.exit(1);
});
