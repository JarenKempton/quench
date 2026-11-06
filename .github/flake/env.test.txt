import { test } from "bun:test";
test("runner env", () => {
  const keys = Object.keys(process.env).filter((k) => /DYLD|LD_|FSPY|VITE|VP_/i.test(k));
  console.log(`RUNNER-ENV ${keys.map((k) => `${k}=${process.env[k]?.slice(0, 160)}`).join(" ")}`);
});
