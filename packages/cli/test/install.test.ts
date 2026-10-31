import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = join(import.meta.dir, "../../..");
const binary = "fake quench binary\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const files = new Map<string, string>();
const served: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    served.push(path);
    const body = files.get(path);
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  },
});
afterAll(() => server.stop(true));
setDefaultTimeout(30_000);

function release(prefix: string, asset: string, sums = `${sha(binary)}  ${asset}\n`) {
  files.clear();
  served.length = 0;
  files.set(`${prefix}/${asset}`, binary);
  files.set(`${prefix}/SHA256SUMS`, sums);
}

async function install(command: string[], env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "quench-install-"));
  const proc = Bun.spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      QUENCH_DOWNLOAD_BASE: server.url.href.replace(/\/$/, ""),
      QUENCH_INSTALL_DIR: join(dir, "bin"),
      QUENCH_RELEASE: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { dir, bin: join(dir, "bin"), stdout, stderr, code };
}

const posix = process.platform !== "win32";
const shAsset = `quench-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const sh = (env?: Record<string, string>) => install(["sh", "install.sh"], env);

test.skipIf(!posix)("install.sh installs the latest stable binary after checking it", async () => {
  release("/latest/download", shAsset);
  const run = await sh();
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(await readFile(join(run.bin, "quench"), "utf8")).toBe(binary);
  expect((await stat(join(run.bin, "quench"))).mode & 0o777).toBe(0o755);
  expect(run.stdout).toContain(`Add it to your PATH: export PATH="${run.bin}:$PATH"`);
});

test.skipIf(!posix)("install.sh refuses a binary whose checksum does not match", async () => {
  release("/latest/download", shAsset, `${sha("other")}  ${shAsset}\n`);
  const run = await sh();
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain(`checksum mismatch for ${shAsset}`);
  expect(await stat(join(run.bin, "quench")).catch(() => null)).toBeNull();
});

test.skipIf(!posix)("install.sh takes a channel or tag from QUENCH_RELEASE", async () => {
  release("/download/nightly", shAsset);
  const run = await sh({ QUENCH_RELEASE: "nightly" });
  expect(run.code).toBe(0);
  expect(served).toEqual([`/download/nightly/${shAsset}`, "/download/nightly/SHA256SUMS"]);
});

async function fakeGh(asset: string) {
  release("/elsewhere", asset);
  const fake = await mkdtemp(join(tmpdir(), "quench-gh-"));
  const assets = join(fake, "assets");
  await Bun.write(join(assets, asset), binary);
  await Bun.write(join(assets, "SHA256SUMS"), `${sha(binary)}  ${asset}\n`);
  await Bun.write(
    join(fake, "gh"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${fake}/calls"`,
      '[ "$1" = auth ] && exit 0',
      'while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done',
      `cp "${assets}"/* "$dir"`,
    ].join("\n"),
  );
  await chmod(join(fake, "gh"), 0o755);
  return {
    env: { PATH: `${fake}${delimiter}${process.env.PATH}` },
    calls: () => readFile(join(fake, "calls"), "utf8"),
  };
}

test.skipIf(!posix)("install.sh falls back to gh when the download is refused", async () => {
  const gh = await fakeGh(shAsset);
  const run = await sh(gh.env);
  expect(run.code).toBe(0);
  expect(run.stderr).toContain("using gh release download");
  expect(await readFile(join(run.bin, "quench"), "utf8")).toBe(binary);
  expect(await gh.calls()).toContain(
    `release download --repo JarenKempton/quench --pattern ${shAsset} --pattern SHA256SUMS`,
  );
});

for (const shell of ["pwsh", "powershell"].filter((name) => Bun.which(name))) {
  const ps = (env?: Record<string, string>) =>
    install([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1"], {
      PROCESSOR_ARCHITECTURE: "AMD64",
      ...env,
    });
  const asset = "quench-windows-x64.exe";

  test(`install.ps1 in ${shell} installs the latest stable exe after checking it`, async () => {
    release("/latest/download", asset);
    const run = await ps();
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(await readFile(join(run.bin, "quench.exe"), "utf8")).toBe(binary);
    expect(run.stdout).toContain("Add it to your PATH:");
  });

  test(`install.ps1 in ${shell} refuses a mismatched checksum and takes QUENCH_RELEASE`, async () => {
    release("/download/v9.9.9", asset, `${sha("other")}  ${asset}\n`);
    const run = await ps({ QUENCH_RELEASE: "v9.9.9" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`checksum mismatch for ${asset}`);
    expect(served).toEqual([`/download/v9.9.9/${asset}`, "/download/v9.9.9/SHA256SUMS"]);
    expect(await stat(join(run.bin, "quench.exe")).catch(() => null)).toBeNull();
  });

  test.skipIf(!posix)(`install.ps1 in ${shell} falls back to gh for nightly`, async () => {
    const gh = await fakeGh(asset);
    const run = await ps({ ...gh.env, QUENCH_RELEASE: "nightly" });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("using gh release download");
    expect(await readFile(join(run.bin, "quench.exe"), "utf8")).toBe(binary);
    expect(await gh.calls()).toContain(
      `release download nightly --repo JarenKempton/quench --pattern ${asset} --pattern SHA256SUMS`,
    );
  });
}
