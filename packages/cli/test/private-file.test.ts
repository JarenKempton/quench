import { expect, test } from "bun:test";
import { mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replacePrivateFile } from "../src/private-file.ts";

const denied = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });

async function dir() {
  return mkdtemp(join(tmpdir(), "quench-private-file-"));
}

test("on Windows a rename refused while another handle holds the file is retried until it lands", async () => {
  const where = await dir();
  const path = join(where, "cache.json");
  let refusals = 3;
  const move = (from: string, to: string) =>
    refusals-- > 0 ? Promise.reject(denied()) : rename(from, to);
  await replacePrivateFile(path, "new", "win32", move);
  expect(await Bun.file(path).text()).toBe("new");
  expect(await readdir(where)).toEqual(["cache.json"]);
});

test("a refusal that never clears, or one off Windows, fails and leaves no temp file behind", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const where = await dir();
    let tries = 0;
    const move = () => {
      tries++;
      return Promise.reject(denied());
    };
    const failed = await replacePrivateFile(join(where, "cache.json"), "new", platform, move).then(
      () => null,
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect(failed).toBe("EPERM");
    expect(tries).toBe(platform === "win32" ? 40 : 1);
    expect(await readdir(where)).toEqual([]);
  }
});
