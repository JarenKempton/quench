import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { update, type Install } from "../src/commands/update.ts";
import { latest, type Release } from "../src/releases.ts";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const files: Record<string, string> = {};
let releases: Release[] = [];
const seenAuth: (string | null)[] = [];

const server = Bun.serve({
  port: 0,
  fetch(request) {
    seenAuth.push(request.headers.get("authorization"));
    const path = new URL(request.url).pathname;
    if (path === "/releases") return Response.json(releases);
    const body = files[path];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  },
});
afterAll(() => server.stop());

function release(
  tag: string,
  binary: string,
  sums = `${sha(binary)}  quench-linux-x64\n`,
): Release {
  files[`/${tag}/bin`] = binary;
  files[`/${tag}/sums`] = sums;
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-nightly."),
    assets: [
      { name: "quench-linux-x64", url: `${server.url.href}${tag}/bin` },
      { name: "SHA256SUMS", url: `${server.url.href}${tag}/sums` },
    ],
  };
}

async function installed(current: string): Promise<Install> {
  const dir = await mkdtemp(join(tmpdir(), "quench-update-"));
  const executable = join(dir, "quench");
  await Bun.write(executable, "old");
  return {
    current,
    executable,
    compiled: true,
    platform: "linux",
    arch: "x64",
    api: server.url.href.replace(/\/$/, ""),
    token: "secret",
  };
}

test("each channel offers its own newest release", () => {
  const all = [
    release("v0.1.0", "a"),
    release("v0.2.0-nightly.20261027.9", "b"),
    release("v0.2.0-nightly.20261027.10", "c"),
    release("v0.1.1", "d"),
    { ...release("v0.3.0", "e"), draft: true },
  ];
  expect(latest(all, "stable")?.tag_name).toBe("v0.1.1");
  expect(latest(all, "nightly")?.tag_name).toBe("v0.2.0-nightly.20261027.10");
});

test("update swaps in the newest release of the installed channel after checking its hash", async () => {
  releases = [release("v0.1.0", "stable one"), release("v0.2.0-nightly.20261027.4", "nightly")];
  const install = await installed("0.1.0-nightly.20261020.1");
  expect(await update(install)).toBe(0);
  expect(await Bun.file(install.executable).text()).toBe("nightly");
  expect(((await Bun.file(install.executable).stat()).mode & 0o777).toString(8)).toBe("755");
  expect(seenAuth.at(-1)).toBe("Bearer secret");

  expect(await update({ ...install, current: "0.2.0-nightly.20261027.4" })).toBe(0);
  expect(await Bun.file(install.executable).text()).toBe("nightly");

  expect(await update({ ...install, current: "0.2.0-nightly.20261027.4" }, "stable")).toBe(0);
  expect(await Bun.file(install.executable).text()).toBe("stable one");
});

test("update changes nothing when the download doesn't match its checksum", async () => {
  releases = [release("v0.2.0", "tampered", `${sha("original")}  quench-linux-x64\n`)];
  const install = await installed("0.1.0");
  expect(await update(install)).toBe(1);
  expect(await Bun.file(install.executable).text()).toBe("old");
  expect(await readdir(join(install.executable, ".."))).toEqual(["quench"]);
});

test("update refuses to overwrite a quench running from source", async () => {
  releases = [release("v0.2.0", "new")];
  const install = await installed("0.0.0-dev");
  expect(await update({ ...install, compiled: false })).toBe(1);
  expect(await Bun.file(install.executable).text()).toBe("old");
});
