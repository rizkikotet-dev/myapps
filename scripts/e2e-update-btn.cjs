// Tes RED/GREEN tombol Cek Update — jalur "tidak ada update".
// node scripts/e2e-update-btn.cjs <url>
const { chromium } = require("playwright");

const url = process.argv[2] || "http://127.0.0.1:55778/";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd.indexOf("updater|check") !== -1) return { available: false, version: "" };
          return null;
        },
        Channel: function () { this.onmessage = function () {}; },
      },
      process: {},
    };
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // klik programatik (bypass actionability playwright)
  await page.evaluate(() => document.querySelector(".update-btn").click());

  // fase sibuk: disabled + label Memeriksa…
  await page.waitForFunction(() => {
    const b = document.querySelector(".update-btn");
    return b && b.disabled === true && b.textContent.indexOf("Memeriksa") !== -1;
  }, null, { timeout: 10000 });

  // jalur "tidak ada update": dialog muncul -> tutup seperti user
  await page.waitForFunction(() => typeof Swal !== "undefined" && Swal.isVisible(), null, { timeout: 10000 });
  await page.evaluate(() => Swal.close());

  // beri waktu handler pulih (post-fix harus segera; pre-fix tidak pernah)
  await page.waitForTimeout(2000);

  const st = await page.evaluate(() => {
    const b = document.querySelector(".update-btn");
    return { disabled: b.disabled, text: b.textContent.trim() };
  });
  console.log("FINAL_STATE=" + JSON.stringify(st));

  const ok = st.disabled === false && /cek update/i.test(st.text);
  console.log(ok ? "PASS: tombol pulih" : "FAIL: tombol macet — disabled=" + st.disabled);
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERROR " + e.message); process.exit(1); });
