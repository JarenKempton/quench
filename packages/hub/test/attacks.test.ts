import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { importInto, MAX_FAILED_ATTEMPTS } from "../src/index.ts";
import { Repo } from "../src/git.ts";
import {
  failure,
  git,
  Owner,
  PASSWORD,
  skillsSource,
  snapshot,
  startHub,
  temp,
  type Running,
} from "./helpers.ts";

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function hubWithSkills() {
  const data = join(temp("data"), "hub");
  await importInto(data, await skillsSource());
  const hub = await startHub(data);
  running.push(hub);
  const owner = new Owner(hub.url, hub.cert);
  await owner.login();
  return { hub, owner };
}

const tls = (hub: Running) => (hub.cert ? { tls: { ca: hub.cert } } : {});

async function object(gitDir: string, type: string, bytes: Uint8Array) {
  const proc = Bun.spawn(["git", "hash-object", "--literally", "-w", "-t", type, "--stdin"], {
    env: { ...process.env, GIT_DIR: gitDir },
    stdin: new Blob([bytes]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`hash-object failed: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

const tree = (entries: [mode: string, name: string, sha: string][]) =>
  Buffer.concat(
    entries.flatMap(([mode, name, sha]) => [
      Buffer.from(`${mode} ${name}\0`),
      Buffer.from(sha, "hex"),
    ]),
  );

async function commitTree(gitDir: string, root: [string, string, string][]) {
  const rootTree = await object(gitDir, "tree", tree(root));
  return git(".", "--git-dir", gitDir, "commit-tree", rootTree, "-m", "crafted");
}

async function pivotCommit(gitDir: string, outside: string) {
  const link = await object(gitDir, "blob", Buffer.from(outside));
  const marker = await object(gitDir, "blob", Buffer.from("pwned\n"));
  const inner = await object(gitDir, "tree", tree([["100644", "marker", marker]]));
  return commitTree(gitDir, [
    ["120000", "pivot", link],
    ["40000", "pivot", inner],
  ]);
}

test("a tree with a duplicate symlink/folder entry never writes outside the extraction folder", async () => {
  const outside = temp("outside");
  const repo = new Repo(join(temp("bare"), "skills.git"));
  await repo.init();
  const commit = await pivotCommit(repo.dir, outside);
  const target = join(temp("target"), "tree");
  expect(await failure(repo.materialize(commit, target))).toContain("duplicate path");
  expect(existsSync(join(outside, "marker"))).toBe(false);
});

test("importing a repo with that tree is refused and writes nothing outside", async () => {
  const outside = temp("outside");
  const source = join(temp("src"), "evil");
  mkdirSync(source);
  await git(source, "init", "--quiet");
  const commit = await pivotCommit(join(source, ".git"), outside);
  await git(source, "update-ref", "HEAD", commit);
  const data = join(temp("data"), "hub");
  expect(await failure(importInto(data, source))).not.toBe("");
  expect(existsSync(join(outside, "marker"))).toBe(false);
  expect(existsSync(join(data, "skills.git"))).toBe(false);
});

test("escaping symlinks, invalid names and .git entries are rejected before any write", async () => {
  const repo = new Repo(join(temp("bare"), "skills.git"));
  await repo.init();
  const skill = await object(repo.dir, "blob", Buffer.from("# a\n"));
  const cases: [string, string, string][] = [
    ["120000", "up", await object(repo.dir, "blob", Buffer.from("../outside"))],
    ["120000", "abs", await object(repo.dir, "blob", Buffer.from(temp("abs")))],
    ["100644", "nul", skill],
    ["100644", "a\\b", skill],
    ["100644", ".git", skill],
  ];
  for (const entry of cases) {
    const commit = await commitTree(repo.dir, [["100644", "SKILL.md", skill], entry]);
    const target = join(temp("target"), "tree");
    expect(await failure(repo.materialize(commit, target))).not.toBe("");
    expect(existsSync(target)).toBe(false);
  }
});

test("a symlink inside the tree still materializes", async () => {
  if (process.platform === "win32") return;
  const repo = new Repo(join(temp("bare"), "skills.git"));
  await repo.init();
  const skill = await object(repo.dir, "blob", Buffer.from("# a\n"));
  const link = await object(repo.dir, "blob", Buffer.from("../SKILL.md"));
  const sub = await object(repo.dir, "tree", tree([["120000", "alias", link]]));
  const commit = await commitTree(repo.dir, [
    ["100644", "SKILL.md", skill],
    ["40000", "refs", sub],
  ]);
  const target = join(temp("target"), "tree");
  await repo.materialize(commit, target);
  expect(await Bun.file(join(target, "refs", "alias")).text()).toBe("# a\n");
});

test("import refuses option-like sources and non-allowlisted transports", async () => {
  const marker = join(temp("marker"), "ran");
  const shell = `touch ${marker}`;
  for (const source of [
    `--upload-pack=${shell}`,
    `-u${shell}`,
    `ext::sh -c ${shell}`,
    "file::/tmp/x",
    "fd::3",
    "http://example.com/skills.git",
    "ftp://example.com/skills.git",
  ]) {
    const data = join(temp("data"), "hub");
    expect(await failure(importInto(data, source))).toContain("source");
    expect(existsSync(join(data, "skills.git"))).toBe(false);
  }
  const cli = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../cli/src/main.ts"),
      "hub",
      "import",
      "--data",
      join(temp("data"), "hub"),
      "--",
      `--upload-pack=${shell}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await cli.exited).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

test("allowed sources still import: a local path", async () => {
  const data = join(temp("data"), "hub");
  expect((await importInto(data, await skillsSource())).skills).toBe(4);
});

test("HEAD and other methods never reach a write handler", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  const query = new URLSearchParams({
    path: "notes.txt",
    base,
    content: "x\n",
    action: "save",
  }).toString();
  for (const method of ["HEAD", "PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${hub.url}/edit?${query}`, {
      method,
      headers: { cookie: owner.cookie, origin: "https://evil.example" },
      ...tls(hub),
    });
    expect(response.status).toBe(405);
  }
  for (const path of ["/toggle", "/revert", "/machines", "/machines/revoke", "/logout"]) {
    const response = await fetch(`${hub.url}${path}`, {
      method: "HEAD",
      headers: { cookie: owner.cookie },
      ...tls(hub),
    });
    expect(response.status).toBe(405);
  }
  expect(await hub.hub.head()).toBe(base);
});

test("every owner form needs the session's CSRF token", async () => {
  const { hub, owner } = await hubWithSkills();
  const html = await (await owner.fetch("/")).text();
  const forms = html.match(/<form method="post"[^>]*>/g) ?? [];
  expect(forms.length).toBeGreaterThan(3);
  expect(html.match(/name="csrf" value="[^"]+"/g)?.length).toBe(forms.length);
  const base = await hub.hub.head();
  const fields = { base, skill: "commit-style", machine: "laptop", on: "0" };
  expect((await owner.post("/toggle", { ...fields, csrf: "" })).status).toBe(403);
  expect((await owner.post("/toggle", { ...fields, csrf: "wrong" })).status).toBe(403);
  expect(await hub.hub.head()).toBe(base);
  expect((await owner.post("/toggle", fields)).status).toBe(303);
  const other = new Owner(hub.url, hub.cert);
  await other.login();
  expect(other.csrf).not.toBe(owner.csrf);
  expect((await other.post("/machines", { name: "x", csrf: owner.csrf })).status).toBe(403);
});

test("concurrent pairing attempts are counted before verification", async () => {
  const { hub, owner } = await hubWithSkills();
  const { code } = await owner.addMachine("laptop");
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  const slowBody = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":'));
        await held;
        controller.enqueue(new TextEncoder().encode('"AAAA-AAAA"}'));
        controller.close();
      },
    });
  const pending = Array.from({ length: 30 }, () =>
    fetch(`${hub.url}/api/v1/pair`, {
      method: "POST",
      body: slowBody(),
      duplex: "half",
      ...tls(hub),
    } as RequestInit).then((r) => r.status),
  );
  await Bun.sleep(300);
  release();
  const attempts = await Promise.all(pending);
  expect(attempts.filter((s) => s === 401).length).toBe(MAX_FAILED_ATTEMPTS);
  expect(attempts.filter((s) => s === 429).length).toBe(30 - MAX_FAILED_ATTEMPTS);
  const good = await fetch(`${hub.url}/api/v1/pair`, {
    method: "POST",
    body: JSON.stringify({ code }),
    ...tls(hub),
  });
  expect(good.status).toBe(429);
});

test("concurrent logins are counted before the password is checked", async () => {
  const { hub } = await hubWithSkills();
  const attempts = await Promise.all(
    Array.from({ length: 30 }, () => new Owner(hub.url, hub.cert).login("wrong password")),
  );
  const statuses = attempts.map((r) => r.status);
  expect(statuses.filter((s) => s === 401).length).toBe(MAX_FAILED_ATTEMPTS);
  expect(statuses.filter((s) => s === 429).length).toBe(30 - MAX_FAILED_ATTEMPTS);
  expect((await new Owner(hub.url, hub.cert).login(PASSWORD)).status).toBe(429);
});

test("a successful pairing does not use up the attempt budget", async () => {
  const { hub, owner } = await hubWithSkills();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) {
    const { code } = await owner.addMachine(`m${i}`);
    const r = await fetch(`${hub.url}/api/v1/pair`, {
      method: "POST",
      body: JSON.stringify({ code }),
      ...tls(hub),
    });
    expect(r.status).toBe(200);
  }
});

test("revoking a machine invalidates its outstanding pairing codes", async () => {
  const { hub, owner } = await hubWithSkills();
  const redeem = (code: string) =>
    fetch(`${hub.url}/api/v1/pair`, {
      method: "POST",
      body: JSON.stringify({ code }),
      ...tls(hub),
    }).then((r) => r.status);
  const first = await owner.addMachine("laptop");
  const second = await owner.addMachine("laptop");
  expect(await redeem(first.code)).toBe(200);
  expect((await owner.post("/machines/revoke", { name: "laptop" })).status).toBe(303);
  expect(await redeem(second.code)).toBe(401);

  const pending = await owner.addMachine("desktop");
  expect((await owner.post("/machines/revoke", { name: "desktop" })).status).toBe(303);
  expect(await redeem(pending.code)).toBe(401);

  const fresh = await owner.addMachine("laptop");
  expect(await redeem(fresh.code)).toBe(200);
});

test("a snapshot held open across revoke and re-pair cannot overwrite the new machine's state", async () => {
  const { hub, owner } = await hubWithSkills();
  const pairWith = async (code: string) =>
    (
      (await (
        await fetch(`${hub.url}/api/v1/pair`, {
          method: "POST",
          body: JSON.stringify({ code }),
          ...tls(hub),
        })
      ).json()) as { token: string }
    ).token;
  const post = (token: string, body: string | ReadableStream<Uint8Array>) =>
    fetch(`${hub.url}/api/v1/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: "half",
      ...tls(hub),
    } as RequestInit);
  const oldToken = await pairWith((await owner.addMachine("laptop")).code);

  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  const stale = JSON.stringify(snapshot(999, {}));
  const slow = post(
    oldToken,
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(stale.slice(0, 10)));
        await held;
        controller.enqueue(new TextEncoder().encode(stale.slice(10)));
        controller.close();
      },
    }),
  );
  await Bun.sleep(200);

  expect((await owner.post("/machines/revoke", { name: "laptop" })).status).toBe(303);
  const newToken = await pairWith((await owner.addMachine("laptop")).code);
  expect((await post(newToken, JSON.stringify(snapshot(1, {})))).status).toBe(200);

  release();
  expect((await slow).status).toBe(401);
  expect(hub.hub.store.machineState("laptop")!.generation).toBe(1);
});

async function heldOwnerPost(
  hub: Running,
  owner: Owner,
  path: string,
  fields: Record<string, string>,
) {
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  const body = new URLSearchParams({ csrf: owner.csrf, ...fields }).toString();
  const response = fetch(`${hub.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: hub.url,
      cookie: owner.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(body.slice(0, 5)));
        await held;
        controller.enqueue(new TextEncoder().encode(body.slice(5)));
        controller.close();
      },
    }),
    duplex: "half",
    ...tls(hub),
  } as RequestInit);
  await Bun.sleep(200);
  expect((await owner.post("/logout", {})).status).toBe(303);
  release();
  return response;
}

test("an owner action held open across logout does not complete", async () => {
  const { hub, owner } = await hubWithSkills();
  const codes = () =>
    (hub.hub.store.db.query("SELECT COUNT(*) AS n FROM pairing_codes").get() as { n: number }).n;
  const before = codes();
  const response = await heldOwnerPost(hub, owner, "/machines", { name: "laptop" });
  expect(response.status).not.toBe(200);
  expect(await response.text()).not.toContain("quench connect");
  expect(codes()).toBe(before);
});

test("a commit held open across logout does not land", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  const response = await heldOwnerPost(hub, owner, "/toggle", {
    base,
    skill: "commit-style",
    machine: "laptop",
    on: "0",
  });
  expect(response.status).not.toBe(303);
  expect(await hub.hub.head()).toBe(base);
});

test("an editor save held open across logout does not land", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  const content = "x\n";
  const { sha256 } = await import("@quench/fleet");
  const response = await heldOwnerPost(hub, owner, "/edit", {
    path: "notes.txt",
    base,
    content,
    previewed: sha256(content),
    action: "save",
  });
  expect(response.status).not.toBe(303);
  expect(await hub.hub.head()).toBe(base);
});

function gate<A extends unknown[], R>(target: { [k: string]: unknown }, name: string) {
  const original = target[name] as (...args: A) => Promise<R>;
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  let entered = () => {};
  const reached = new Promise<void>((done) => (entered = done));
  let once = true;
  target[name] = async (...args: A) => {
    if (once) {
      once = false;
      entered();
      await held;
    }
    return original.apply(target, args);
  };
  return { reached, release };
}

const objectExists = async (gitDir: string, content: string) => {
  const hash = Bun.spawnSync(["git", "hash-object", "--stdin"], {
    stdin: new Blob([content]),
  })
    .stdout.toString()
    .trim();
  const proc = Bun.spawn(["git", "--git-dir", gitDir, "cat-file", "-e", hash], {
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
};

const formPost = (hub: Running, owner: Owner, path: string, fields: Record<string, string>) =>
  fetch(`${hub.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: hub.url,
      cookie: owner.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf: owner.csrf, ...fields }).toString(),
    ...tls(hub),
  });

test("an editor preview never writes git objects", async () => {
  const { hub, owner } = await hubWithSkills();
  const content = `preview only ${crypto.randomUUID()}\n`;
  const base = await hub.hub.head();
  const preview = await owner.post("/edit", {
    path: "notes.txt",
    base,
    content,
    action: "preview",
  });
  expect(await preview.text()).toContain("+preview only");
  expect(await objectExists(hub.hub.repo.dir, content)).toBe(false);
});

test("an owner action queued behind logout runs the guard when it is dequeued", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  const { reached, release } = gate(hub.hub as never, "toggle");
  const first = formPost(hub, owner, "/toggle", {
    base,
    skill: "commit-style",
    machine: "laptop",
    on: "0",
  });
  await reached;
  const logout = formPost(hub, owner, "/logout", {});
  await Bun.sleep(50);
  const content = `queued preview ${crypto.randomUUID()}\n`;
  const preview = formPost(hub, owner, "/edit", {
    path: "notes.txt",
    base,
    content,
    action: "preview",
  });
  await Bun.sleep(100);
  release();
  expect((await first).status).toBe(303);
  expect((await logout).status).toBe(303);
  const queued = await preview;
  expect(queued.status).toBe(401);
  expect(await queued.text()).not.toContain("queued preview");
  expect(await objectExists(hub.hub.repo.dir, content)).toBe(false);
});

test("an owner page paused across logout is not sent", async () => {
  const { hub, owner } = await hubWithSkills();
  const { reached, release } = gate(hub.hub as never, "fleetAt");
  const page = owner.fetch("/");
  await reached;
  expect((await formPost(hub, owner, "/logout", {})).status).toBe(303);
  release();
  const response = await page;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("Skills by machine");
});

async function pairedLaptop(hub: Running, owner: Owner) {
  const { code } = await owner.addMachine("laptop");
  const r = await fetch(`${hub.url}/api/v1/pair`, {
    method: "POST",
    body: JSON.stringify({ code }),
    ...tls(hub),
  });
  return ((await r.json()) as { token: string }).token;
}

const machineGet = (hub: Running, path: string, token: string) =>
  fetch(`${hub.url}${path}`, { headers: { authorization: `Bearer ${token}` }, ...tls(hub) });

test("a bundle request paused across revoke returns nothing created after it", async () => {
  const { hub, owner } = await hubWithSkills();
  const token = await pairedLaptop(hub, owner);
  const { reached, release } = gate(hub.hub as never, "head");
  const pending = machineGet(hub, "/api/v1/bundle", token);
  await reached;
  expect((await owner.post("/machines/revoke", { name: "laptop" })).status).toBe(303);
  const secret = `after revoke ${crypto.randomUUID()}\n`;
  const base = await hub.hub.head();
  await hub.hub.writeFile(
    base,
    "skills/writing/commit-style/SKILL.md",
    secret,
    "Change after revoke",
  );
  release();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(base);
});

test("a blob request paused across revoke returns no bytes", async () => {
  const { hub, owner } = await hubWithSkills();
  const token = await pairedLaptop(hub, owner);
  const manifest = (await (await machineGet(hub, "/api/v1/bundle", token)).json()) as {
    skills: Record<string, { files: { sha256: string }[] }>;
  };
  const digest = manifest.skills["commit-style"]!.files[0]!.sha256;
  const { reached, release } = gate(hub.hub as never, "blob");
  const pending = machineGet(hub, `/api/v1/blobs/${digest}`, token);
  await reached;
  expect((await owner.post("/machines/revoke", { name: "laptop" })).status).toBe(303);
  release();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("commit");
});
