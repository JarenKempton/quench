import { chromium } from "/tmp/hero-tools/node_modules/playwright";
const url = process.env.URL ?? "http://localhost:4350";
const browser = await chromium.launch({ executablePath: "/usr/lib/chromium/chromium" });
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() =>
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")),
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/landing-fable-${width}.png`, fullPage: true });
}
await browser.close();
