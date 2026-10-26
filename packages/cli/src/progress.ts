import type { Progress } from "@quench/history";
import { count } from "./format.ts";

const EVERY_MS = 100;

export function reading(): Progress {
  if (!process.stderr.isTTY) return () => {};
  let shown = 0;
  return (done, total) => {
    if (done === total) {
      process.stderr.write("\r\x1b[2K");
      return;
    }
    if (Date.now() - shown < EVERY_MS) return;
    shown = Date.now();
    process.stderr.write(`\r\x1b[2KReading sessions ${count(done)} of ${count(total)}…`);
  };
}
