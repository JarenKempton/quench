import { rename } from "node:fs/promises";
import { chromium } from "/tmp/hero-tools/node_modules/playwright";

const url = process.env.URL ?? "http://localhost:4350";
const exe = "/usr/lib/chromium/chromium";
const browser = await chromium.launch({ executablePath: exe });

for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() =>
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in")),
  );
  await page.waitForTimeout(5600);
  await page.screenshot({ path: `/tmp/landing-fable-${width}.png`, fullPage: true });
  await page.close();
}

const frames = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await frames.goto(url, { waitUntil: "networkidle" });
const box = await frames.evaluate(() => {
  const r = document.querySelector(".hero-anim")!.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const at = [500, 1800, 5200];
let elapsed = 0;
for (const [i, t] of at.entries()) {
  await frames.waitForTimeout(t - elapsed);
  elapsed = t;
  await frames.screenshot({
    path: `/tmp/landing-fable-hero-frame-${i + 1}.png`,
    clip: box,
    animations: "allow",
  });
}
await frames.close();

const recording = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "/tmp/landing-fable-video", size: { width: 1440, height: 900 } },
});
const clip = await recording.newPage();
await clip.goto(url, { waitUntil: "networkidle" });
await clip.waitForTimeout(5800);
const video = clip.video();
await recording.close();
if (video) await rename(await video.path(), "/tmp/landing-fable.webm");

await browser.close();
