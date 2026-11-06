import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
const out = process.argv[2] ?? "probe.log";
const fd = openSync(`${out}.tick`, "w");
let last = performance.now();
let lastIo = 0;
const log = (s: string) => Bun.write(Bun.file(out), "").then(() => {});
const lines: string[] = [];
setInterval(() => {
  const now = performance.now();
  const t0 = performance.now();
  writeSync(fd, "x");
  fsyncSync(fd);
  lastIo = performance.now() - t0;
  const gap = now - last;
  if (gap > 250 || lastIo > 250)
    console.log(`${new Date().toISOString()} PROBE gap=${gap.toFixed(0)}ms io=${lastIo.toFixed(0)}ms`);
  last = now;
}, 50);
process.on("SIGTERM", () => { closeSync(fd); process.exit(0); });
void log; void lines;
