// Diagnostik: hitung pemanggilan convertAll & detail tiap event download.
const { chromium } = require("playwright");
const ROOT = "C:/Users/rizkivalency/Desktop/myapps";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:55777/", { waitUntil: "load" });

  await page.evaluate(() => {
    document.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = false; });
    // pembungkus penghitung — onclick atribut memanggil window.convertAll saat klik
    const orig = window.convertAll;
    window.__calls = 0;
    window.convertAll = function (...a) {
      window.__calls++;
      console.log("CONVERTALL CALL #" + window.__calls);
      return orig.apply(this, a);
    };
  });

  await page.setInputFiles("#fi", ROOT + "/tmp/e2e-split.wav");
  await page.evaluate(() => {
    const s = document.getElementById("spd");
    s.value = "1";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const dl = [];
  page.on("download", (d) => { dl.push({ name: d.suggestedFilename(), url: d.url() }); console.log("DL " + d.suggestedFilename() + " <- " + d.url()); });

  await page.click("#conv-btn");
  await page.waitForFunction(
    () => !!document.getElementById("conv-btn") && !document.getElementById("conv-btn").disabled,
    null,
    { timeout: 300000, polling: 1000 }
  );
  await page.waitForTimeout(1500);

  const calls = await page.evaluate(() => window.__calls);
  console.log("RESULT " + JSON.stringify({ convertAllCalls: calls, downloads: dl.length, dl }, null, 1));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("E2E-FAIL " + e.message); process.exit(1); });
