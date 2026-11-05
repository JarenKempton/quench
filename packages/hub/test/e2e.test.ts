import { afterAll, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@quench/fleet";
import { clientDir, fetchBundle, postSnapshot, storedBundle, blobPath } from "../src/client.ts";
import {
  git,
  lines,
  Owner,
  PASSWORD,
  quench,
  run,
  sharedSource,
  snapshot,
  temp,
} from "./helpers.ts";

const servers: ReturnType<typeof quench>[] = [];
afterAll(async () => {
  for (const proc of servers) {
    proc.kill();
    await proc.exited;
  }
});

test("hub serve, import, add machine, connect with pin, bundle, snapshot, toggle, revert", async () => {
  const source = await sharedSource();
  const hubHome = temp("hub-home");
  const data = join(hubHome, "data");

  const imported = await run(hubHome, ["hub", "import", source, "--data", data]);
  expect(imported.stderr).not.toContain("error");
  expect(imported.code).toBe(0);
  expect(imported.stdout).toContain("converted its manifests to the fleet file");
  const history = await git(
    data,
    "--git-dir",
    join(data, "skills.git"),
    "log",
    "--format=%s",
    "main",
  );
  expect(history.split("\n")).toEqual([
    "Convert registry and host manifests to the fleet file",
    "Revise commit-style",
    "Add skills",
  ]);

  const server = quench(hubHome, ["hub", "serve", "--data", data, "--listen", "127.0.0.1:0"], {
    QUENCH_HUB_PASSWORD: PASSWORD,
  });
  servers.push(server);
  const banner = await lines(server, /Certificate pin sha256:[0-9a-f]{64}\n/);
  const url = /Quench hub at (https:\/\/\S+)/.exec(banner)![1]!;
  const printedPin = /Certificate pin (\S+)/.exec(banner)![1]!;
  const cert = readFileSync(join(data, "tls", "cert.pem"), "utf8");

  const owner = new Owner(url, cert);
  expect((await owner.login()).status).toBe(303);
  const added = await owner.addMachine("laptop");
  expect(added.command).toMatch(
    /^quench connect https:\/\/127\.0\.0\.1:\d+ --code [0-9A-Z]{4}-[0-9A-Z]{4} --pin sha256:[0-9a-f]{64}$/,
  );
  expect(added.pin).toBe(printedPin);

  const laptopHome = temp("laptop");
  const connected = await run(laptopHome, [
    "connect",
    added.url,
    "--code",
    added.code,
    "--pin",
    added.pin!,
  ]);
  expect(connected.stderr).toBe("");
  expect(connected.code).toBe(0);
  expect(connected.stdout).toContain("as laptop");

  const dir = clientDir(laptopHome);
  if (process.platform !== "win32") expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
  const first = (await storedBundle(dir))!;
  expect(first.id).toBe(`sha256:${sha256(JSON.stringify(first.manifest))}`);
  expect(first.manifest.machine).toBe("laptop");
  expect(Object.keys(first.manifest.skills).sort()).toEqual([
    "commit-style",
    "review-checklist",
    "scratchpad",
  ]);
  for (const skill of Object.values(first.manifest.skills))
    for (const file of skill.files)
      expect(sha256(readFileSync(blobPath(dir, file.sha256)))).toBe(file.sha256);
  expect(
    readFileSync(blobPath(dir, first.manifest.skills["commit-style"]!.files[0]!.sha256), "utf8"),
  ).toContain("revised");

  const unassigned = sha256(readFileSync(join(source, "skills/ops/deploy-notes/SKILL.md")));
  expect(JSON.stringify(first.manifest)).not.toContain(unassigned);
  const token = readFileSync(join(dir, "token"), "utf8").trim();
  const denied = await fetch(`${url}/api/v1/blobs/${unassigned}`, {
    headers: { authorization: `Bearer ${token}` },
    tls: { ca: cert },
  });
  expect(denied.status).toBe(404);

  const posted = await postSnapshot(
    dir,
    snapshot(1, {
      "claude-code": {
        complete: true,
        conflicts: 0,
        installs: [
          {
            skill: "commit-style",
            path: "~/.claude/skills/commit-style",
            location: { scope: "global" },
            treeHash: first.manifest.skills["commit-style"]!.treeHash,
            state: "owned",
          },
        ],
      },
    }) as never,
  );
  expect(posted.machine).toBe("laptop");
  expect(await (await owner.fetch("/")).text()).toContain("claude-code: 1 installed, 0 conflicts");

  const base = await owner.head();
  expect(
    (await owner.post("/toggle", { base, skill: "commit-style", machine: "laptop", on: "0" }))
      .status,
  ).toBe(303);
  const stale = await owner.post("/toggle", {
    base,
    skill: "scratchpad",
    machine: "laptop",
    on: "0",
  });
  expect(stale.status).toBe(409);

  const afterToggle = await fetchBundle(dir);
  expect(afterToggle.changed).toBe(true);
  expect(afterToggle.bundle.id).not.toBe(first.id);
  expect(Object.keys(afterToggle.bundle.manifest.skills).sort()).toEqual([
    "review-checklist",
    "scratchpad",
  ]);

  const toggled = await owner.head();
  expect((await owner.post("/revert", { base: toggled, commit: toggled })).status).toBe(303);
  const afterRevert = await fetchBundle(dir);
  expect(Object.keys(afterRevert.bundle.manifest.skills).sort()).toEqual([
    "commit-style",
    "review-checklist",
    "scratchpad",
  ]);
  expect((await fetchBundle(dir)).changed).toBe(false);
}, 60_000);
