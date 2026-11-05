import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  importInto,
  MAX_FAILED_ATTEMPTS,
  PAIRING_TTL_MS,
  selfSignedCertificate,
} from "../src/index.ts";
import { clientDir, fetchBundle, hubUrl, pair, postSnapshot } from "../src/client.ts";
import { MAX_SNAPSHOT_BYTES } from "../src/server.ts";
import { failure, Owner, skillsSource, snapshot, startHub, temp, type Running } from "./helpers.ts";

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function hubWithSkills(options: Parameters<typeof startHub>[1] = {}) {
  const data = join(temp("data"), "hub");
  await importInto(data, await skillsSource());
  const hub = await startHub(data, options);
  running.push(hub);
  const owner = new Owner(hub.url, hub.cert);
  await owner.login();
  return { hub, owner, data };
}

const api = (hub: Running, path: string, token: string, init: RequestInit = {}) =>
  fetch(`${hub.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    ...(hub.cert ? { tls: { ca: hub.cert } } : {}),
  });

const redeem = (hub: Running, code: string) =>
  fetch(`${hub.url}/api/v1/pair`, {
    method: "POST",
    body: JSON.stringify({ code }),
    ...(hub.cert ? { tls: { ca: hub.cert } } : {}),
  });

test("a pairing code works once", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  expect((await redeem(hub, code)).status).toBe(200);
  expect((await redeem(hub, code)).status).toBe(401);
});

test("a pairing code expires after 10 minutes", async () => {
  let now = Date.now();
  const { hub, owner } = await hubWithSkills({ now: () => now });
  const { code } = await owner.addMachine("laptop");
  now += PAIRING_TTL_MS + 1;
  expect((await redeem(hub, code)).status).toBe(401);
});

test("pairing is rate-limited, even for a valid code", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
    expect((await redeem(hub, "AAAA-AAAA")).status).toBe(401);
  expect((await redeem(hub, code)).status).toBe(429);
});

test("codes are 8 characters of a 32-letter alphabet", async () => {
  const { owner } = await hubWithSkills();
  const codes = new Set<string>();
  for (const name of ["a", "b", "c", "d"]) codes.add((await owner.addMachine(name)).code);
  expect(codes.size).toBe(4);
  for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

test("tokens and codes are stored hashed", async () => {
  const { hub, owner, data } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  const { token } = (await (await redeem(hub, code)).json()) as { token: string };
  hub.hub.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  const db = readFileSync(join(data, "hub.sqlite")).toString("latin1");
  expect(db).not.toContain(token);
  expect(db).not.toContain(code);
  expect(db).not.toContain(code.replace("-", ""));
});

test("revoking one machine leaves the others working", async () => {
  const { hub, owner } = await hubWithSkills();
  const tokens: Record<string, string> = {};
  for (const name of ["laptop", "desktop"]) {
    const { code } = await owner.addMachine(name);
    tokens[name] = ((await (await redeem(hub, code)).json()) as { token: string }).token;
  }
  expect((await owner.post("/machines/revoke", { name: "laptop" })).status).toBe(303);
  expect((await api(hub, "/api/v1/bundle", tokens.laptop!)).status).toBe(401);
  expect((await api(hub, "/api/v1/bundle", tokens.desktop!)).status).toBe(200);
});

test("identity comes from the token, never from the payload", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  await owner.addMachine("desktop");
  const { token } = (await (await redeem(hub, code)).json()) as { token: string };
  const bundle = await api(hub, "/api/v1/bundle?machine=desktop", token, {
    headers: { "x-quench-machine": "desktop" },
  });
  expect(((await bundle.json()) as { machine: string }).machine).toBe("laptop");
  const claimed = { ...snapshot(1, {}), machine: "desktop" };
  const posted = await api(hub, "/api/v1/snapshot", token, {
    method: "POST",
    body: JSON.stringify(claimed),
  });
  expect(posted.status).toBe(400);
  expect(hub.hub.store.machineState("desktop")).toBeNull();
  expect((await api(hub, "/api/v1/bundle", "qm_made-up-token-value")).status).toBe(401);
});

test("an unassigned skill is never served, whatever its hash", async () => {
  const { hub, owner, data } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  const { token } = (await (await redeem(hub, code)).json()) as { token: string };
  const manifest = (await (await api(hub, "/api/v1/bundle", token)).json()) as {
    skills: Record<string, { files: { sha256: string }[] }>;
  };
  expect(Object.keys(manifest.skills)).not.toContain("deploy-notes");
  const head = await hub.hub.head();
  const files = (await hub.hub.bundle("desktop", head)).manifest.skills["deploy-notes"]!.files;
  expect(files.length).toBeGreaterThan(0);
  for (const file of files)
    expect((await api(hub, `/api/v1/blobs/${file.sha256}`, token)).status).toBe(404);
  const assigned = manifest.skills["commit-style"]!.files[0]!.sha256;
  expect((await api(hub, `/api/v1/blobs/${assigned}`, token)).status).toBe(200);
  expect(existsSync(data)).toBe(true);
});

test("snapshots are bounded, validated, and replace a harness only when complete", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  const { token } = (await (await redeem(hub, code)).json()) as { token: string };
  const post = (body: string) => api(hub, "/api/v1/snapshot", token, { method: "POST", body });
  expect((await post("x".repeat(MAX_SNAPSHOT_BYTES + 1))).status).toBe(413);
  expect((await post("{not json")).status).toBe(400);
  expect((await post(JSON.stringify({ version: 1 }))).status).toBe(400);
  const install = (skill: string) => ({
    skill,
    path: `~/.claude/skills/${skill}`,
    location: { scope: "global" },
    treeHash: `sha256:${"a".repeat(64)}`,
    state: "owned",
  });
  const full = { complete: true, conflicts: 0, installs: [install("commit-style")] };
  expect(
    (await post(JSON.stringify(snapshot(1, { "claude-code": full, codex: full })))).status,
  ).toBe(200);
  const partial = { complete: false, conflicts: 0, installs: [] };
  const fresh = { complete: true, conflicts: 1, installs: [install("scratchpad")] };
  expect(
    (await post(JSON.stringify(snapshot(2, { "claude-code": partial, codex: fresh })))).status,
  ).toBe(200);
  const state = hub.hub.store.machineState("laptop")!;
  expect(state.generation).toBe(2);
  expect(state.harnesses["claude-code"]!.stale).toBe(true);
  expect(state.harnesses["claude-code"]!.snapshot.installs.map((i) => i.skill)).toEqual([
    "commit-style",
  ]);
  expect(state.harnesses.codex!.snapshot.installs.map((i) => i.skill)).toEqual(["scratchpad"]);
});

test("the client refuses a wrong pin and writes no token", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code, url } = await owner.addMachine("laptop");
  const dir = clientDir(temp("client"));
  const wrong = `sha256:${"0".repeat(64)}`;
  expect(await failure(pair(dir, { url, code, pin: wrong }))).toContain("not the --pin given");
  expect(existsSync(join(dir, "token"))).toBe(false);
  expect((await redeem(hub, code)).status).toBe(200);
});

test("without a pin, a self-signed hub fails normal certificate verification", async () => {
  const { owner } = await hubWithSkills();
  const { code, url } = await owner.addMachine("laptop");
  const dir = clientDir(temp("client"));
  expect(await failure(pair(dir, { url, code }))).toContain("self signed certificate");
  expect(existsSync(join(dir, "token"))).toBe(false);
});

test("a hub with its own certificate shows no pin", async () => {
  const tls = selfSignedCertificate(["127.0.0.1"]);
  const { owner } = await hubWithSkills({ tls });
  const { command, pin } = await owner.addMachine("laptop");
  expect(pin).toBeUndefined();
  expect(command).toMatch(/^quench connect https:\/\/127\.0\.0\.1:\d+ --code \S+$/);
});

test("plain HTTP is allowed on loopback only", async () => {
  expect(await failure(startHub(temp("data"), { http: true, hostname: "0.0.0.0" }))).toContain(
    "loopback",
  );
  expect(() => hubUrl("http://hub.example.com")).toThrow("loopback");
  expect(() => hubUrl("http://192.168.1.10:8080")).toThrow("loopback");
  const { hub, owner } = await hubWithSkills({ http: true });
  expect(hub.url).toStartWith("http://127.0.0.1:");
  expect(hub.pin).toBeNull();
  const { code, url, pin } = await owner.addMachine("laptop");
  expect(pin).toBeUndefined();
  const dir = clientDir(temp("client"));
  await pair(dir, { url, code });
  const { bundle } = await fetchBundle(dir);
  expect(bundle.manifest.machine).toBe("laptop");
  expect((await postSnapshot(dir, snapshot(1, {}) as never)).machine).toBe("laptop");
});

test("the owner password is required and stored as a hash", async () => {
  const data = temp("data");
  expect(await failure(startHub(data, { password: "" }))).toContain("QUENCH_HUB_PASSWORD");
  const hub = await startHub(data);
  running.push(hub);
  const owner = new Owner(hub.url, hub.cert);
  expect((await owner.login("wrong password")).status).toBe(401);
  expect((await owner.fetch("/")).status).toBe(200);
  expect(await (await owner.fetch("/")).text()).toContain('type="password"');
  expect((await owner.login()).status).toBe(303);
  const row = hub.hub.store.db.query("SELECT password_hash FROM owner").get() as {
    password_hash: string;
  };
  expect(row.password_hash).toStartWith("$argon2");
});

test("owner forms refuse cross-origin posts", async () => {
  const { owner } = await hubWithSkills();
  const response = await owner.fetch("/machines", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "name=laptop",
  });
  expect(response.status).toBe(403);
});
