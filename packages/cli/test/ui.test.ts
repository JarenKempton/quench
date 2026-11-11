import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, stat } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { harnessById, Home, type SessionRef } from "@quench/history";
import { provider, type Provider } from "@quench/judge";
import { CSP, lastResult, serveUi, startUi, uiAssets } from "../src/commands/ui.ts";
import { day, fixture, session } from "./correction-home.ts";
import { cliRunsTimeout, lines, quench } from "./run.ts";

const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });

const assets = new Map<string, Blob>([
  ["index.html", new Blob(["<!doctype html><title>Quench</title>"])],
]);
const server = serveUi({
  port: 0,
  api: {
    report: async () => ({ harnesses: [] }),
    skills: async () => ({ skills: [] }),
    corrections: async () => ({ judge: null }),
  },
  assets,
});
afterAll(() => server.stop());

test("binds 127.0.0.1 only", async () => {
  expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (outside) {
    const reached = await fetch(`http://${outside.address}:${server.port}/`).then(
      () => true,
      () => false,
    );
    expect(reached).toBe(false);
  }
  expect((await get(server.port, "/")).status).toBe(200);
});

test("every response carries the strict CSP, DENY framing and no-store", async () => {
  for (const path of ["/", "/api/report", "/api/skills", "/api/corrections", "/missing.js"]) {
    const { headers } = await get(server.port, path);
    expect(headers["content-security-policy"]).toBe(CSP);
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["cache-control"]).toBe("no-store");
  }
  expect(CSP).toContain("script-src 'self'");
  expect(CSP).not.toContain("unsafe-inline");
});

test("a foreign Host header is rejected, so DNS rebinding can't read the API", async () => {
  for (const host of [
    "evil.example",
    `evil.example:${server.port}`,
    `localhost:${server.port}`,
    "127.0.0.1:1",
  ]) {
    for (const path of ["/api/report", "/api/skills", "/api/corrections"]) {
      const response = await get(server.port, path, host);
      expect(response.status).toBe(421);
      expect(response.body).not.toContain("harnesses");
      expect(response.body).not.toContain("skills");
      expect(response.body).not.toContain("judge");
    }
  }
});

test("an API answer that takes longer than Bun's 10 s idle timeout still arrives", async () => {
  const slow = serveUi({
    port: 0,
    api: { corrections: () => Bun.sleep(15_000).then(() => ({ judge: null })) },
    assets,
  });
  try {
    const answer = await fetch(`${slow.url}api/corrections`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ judge: null });
  } finally {
    await slow.stop();
  }
}, 25_000);

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "quench-cli-ui-"));
  for (const name of ["verify", "deploy"])
    await Bun.write(
      join(dir, ".claude/skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} things\n---\nBody.\n`,
    );
  await Bun.write(
    join(dir, ".claude/projects/demo/s1.jsonl"),
    lines([
      {
        type: "attachment",
        sessionId: "s1",
        timestamp: at(10),
        attachment: {
          type: "skill_listing",
          names: ["verify", "deploy"],
          content: "- verify\n- deploy",
        },
      },
      { type: "user", timestamp: at(9), message: { role: "user", content: "fix the build" } },
      {
        type: "assistant",
        timestamp: at(8),
        message: {
          id: "m1",
          model: "model-x",
          content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "verify" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]),
  );
  return dir;
}

test(
  "/api/skills equals quench skills --json on the same home, kept until a refresh reads it again",
  async () => {
    const dir = await home();
    const expected = await quench(dir, "skills", "--json", "--no-host-history");
    expect(expected.code).toBe(0);
    expect(JSON.parse(expected.stdout).skills.length).toBe(2);
    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
      judge: null,
    });
    if (running instanceof Error) throw running;
    try {
      expect(running.url).toStartWith("http://127.0.0.1:");
      const served = await get(running.port, "/api/skills");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(served.headers["x-quench-computed-at"]).toBeString();
      expect(JSON.parse(served.body)).toEqual(JSON.parse(expected.stdout));
      await Bun.write(
        join(dir, ".claude/skills/tidy/SKILL.md"),
        "---\nname: tidy\ndescription: tidy\n---\n",
      );
      const names = async (path: string) => {
        const response = await get(running.port, path);
        return {
          refreshing: response.headers["x-quench-refreshing"],
          skills: JSON.parse(response.body).skills.map((r: { skill: string }) => r.skill),
        };
      };
      expect((await names("/api/skills")).skills).not.toContain("tidy");
      expect(await names("/api/skills?refresh=1")).toMatchObject({ refreshing: "true" });
      let after = await names("/api/skills");
      while (after.refreshing === "true") {
        await Bun.sleep(50);
        after = await names("/api/skills");
      }
      expect(after.skills).toContain("tidy");
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

test(
  "/api/report equals quench report --json on the same home, kept until a refresh reads it again",
  async () => {
    const dir = await home();
    const expected = await quench(dir, "report", "--json");
    expect(expected.code).toBe(0);
    const want = JSON.parse(expected.stdout);
    expect(want.harnesses[0].days).toHaveLength(1);
    expect(want.harnesses[0].startParts.map((p: { kind: string }) => p.kind)).toContain("skills");
    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
      judge: null,
    });
    if (running instanceof Error) throw running;
    try {
      const served = await get(running.port, "/api/report");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(served.headers["x-quench-computed-at"]).toBeString();
      expect(JSON.parse(served.body)).toEqual(want);
      await Bun.write(
        join(dir, ".claude/projects/demo/s2.jsonl"),
        lines([
          {
            type: "user",
            sessionId: "s2",
            timestamp: at(5),
            message: { role: "user", content: "hi" },
          },
          {
            type: "assistant",
            timestamp: at(4),
            message: {
              id: "m2",
              model: "model-y",
              content: [],
              usage: { input_tokens: 7, output_tokens: 1 },
            },
          },
        ]),
      );
      const sessions = async (path: string) => {
        const response = await get(running.port, path);
        return {
          refreshing: response.headers["x-quench-refreshing"],
          sessions: JSON.parse(response.body).harnesses[0].sessions,
        };
      };
      expect((await sessions("/api/report")).sessions).toBe(want.harnesses[0].sessions);
      expect(await sessions("/api/report?refresh=1")).toMatchObject({ refreshing: "true" });
      let after = await sessions("/api/report");
      while (after.refreshing === "true") {
        await Bun.sleep(50);
        after = await sessions("/api/report");
      }
      expect(after.sessions).toBe(want.harnesses[0].sessions + 1);
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

test(
  "Overview, Skills and Tasks opened at once parse each session once, and a refresh parses it once more",
  async () => {
    const dir = await home();
    const claude = harnessById["claude-code"];
    const original = Object.getOwnPropertyDescriptor(claude, "read")!;
    const read = claude.read.bind(claude);
    const parsed: string[] = [];
    claude.read = async (ref: SessionRef) => {
      parsed.push(ref.path);
      await Bun.sleep(300);
      return read(ref);
    };
    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
      judge: null,
    });
    try {
      if (running instanceof Error) throw running;
      const opened = await Promise.all(
        ["/api/report", "/api/skills", "/api/tasks"].map((path) => get(running.port, path)),
      );
      expect(opened.map((r) => r.status)).toEqual([200, 200, 200]);
      const s1 = join(dir, ".claude/projects/demo/s1.jsonl");
      expect(parsed).toEqual([s1]);
      let after = await get(running.port, "/api/report?refresh=1");
      while (after.headers["x-quench-refreshing"] === "true") {
        await Bun.sleep(50);
        after = await get(running.port, "/api/report");
      }
      expect(parsed).toEqual([s1, s1]);
    } finally {
      Object.defineProperty(claude, "read", original);
      if (!(running instanceof Error)) await running.stop();
    }
  },
  cliRunsTimeout,
);

test("only the named API endpoints answer", async () => {
  for (const path of ["/api/", "/api/constructor", "/api/toString", "/api/report/x"])
    expect((await get(server.port, path)).status).toBe(404);
});

async function tree(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`));
}

test(
  "/api/corrections is quench corrections --json --context --cached-only with only the shown file histories, calls no judge and writes nothing",
  async () => {
    const dir = await fixture();
    const work = JSON.stringify(join(dir, "work", "CLAUDE.md")).slice(1, -1);
    const once = JSON.stringify(join(dir, "elsewhere", "AGENTS.md")).slice(1, -1);
    await Bun.write(join(dir, "elsewhere", "AGENTS.md"), "Once.\n");
    await Bun.write(
      join(dir, ".claude/projects/-work/once.jsonl"),
      session(dir, { id: "once", at: day(3, 1), corrected: false }).replaceAll(work, once),
    );
    const expected = await quench(
      dir,
      "corrections",
      "--json",
      "--context",
      "--cached-only",
      "--days",
      "36500",
      "--no-host-history",
    );
    expect(expected.stderr).toBe("");
    const report = JSON.parse(expected.stdout);
    const { floor, files } = report.context.history;
    const shown = files.filter((f: { sessions: number }) => f.sessions >= floor);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(files.length);
    expect(report.weekly.length).toBeGreaterThan(0);
    let created = 0;
    const judge: Provider = {
      ...provider({ name: "jev", apiKey: "must-not-be-used" }),
      create: async () => {
        created++;
        throw new Error("the UI must not create a judge");
      },
    };
    const running = await startUi(new Home(dir), {
      days: 36500,
      cache: true,
      open: false,
      hostHistory: false,
      judge,
    });
    if (running instanceof Error) throw running;
    try {
      const before = await tree(dir);
      const served = await get(running.port, "/api/corrections");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(served.headers["x-quench-computed-at"]).toBeString();
      expect(JSON.parse(served.body)).toEqual({
        ...report,
        context: {
          ...report.context,
          history: { ...report.context.history, total: files.length, files: shown },
        },
      });
      expect(created).toBe(0);
      for (const text of ["no, wrong", "thanks", "fix it", "Use Bun", "test suite", "done"])
        expect(served.body).not.toContain(text);
      expect(await tree(dir)).toEqual(before);
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

test(
  "/api/tasks lists each task's verdicts from cached judgments only, with ids and labels but no history text, and writes only its own segment cache",
  async () => {
    const dir = await fixture();
    let created = 0;
    const judge: Provider = {
      ...provider({ name: "jev", apiKey: "must-not-be-used" }),
      create: async () => {
        created++;
        throw new Error("the UI must not create a judge");
      },
    };
    const running = await startUi(new Home(dir), {
      days: 36500,
      cache: true,
      open: false,
      hostHistory: false,
      judge,
    });
    if (running instanceof Error) throw running;
    try {
      const before = await tree(dir);
      const served = await get(running.port, "/api/tasks");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(served.headers["x-quench-computed-at"]).toBeString();
      const report = JSON.parse(served.body);
      expect(report.days).toBe(36500);
      expect(report.tasks.length).toBeGreaterThan(0);
      for (const task of report.tasks) {
        expect(task.taskId).toMatch(/^[0-9a-f]{32}$/);
        for (const key of ["landed", "spiral", "efficiency"])
          expect(["pass", "fail", "unknown"]).toContain(task[key].verdict);
        expect(["kept", "skipped", "unknown"]).toContain(task.guidance);
        expect(task).not.toHaveProperty("guidanceUnreliableRule");
      }
      expect(report.tasks.map((t: { startedAt: string }) => t.startedAt)).toEqual(
        report.tasks
          .map((t: { startedAt: string }) => t.startedAt)
          .sort()
          .reverse(),
      );
      expect(created).toBe(0);
      for (const text of ["no, wrong", "thanks", "fix it", "Use Bun", "test suite", "done"])
        expect(served.body).not.toContain(text);
      const own = (e: string) =>
        e.startsWith(`${join(".quench", "local")}:`) ||
        e.startsWith(join(".quench", "local", "task-segments.json"));
      expect((await tree(dir)).filter((e) => !own(e))).toEqual(before.filter((e) => !own(e)));
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

const CANARY = "ghp_" + "QuenchUiCanary0123456789abcdefghijkl";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=q", "-c", "user.email=q@q", "-c", "init.defaultBranch=main", ...args],
    { cwd },
  );
  if (!result.success) throw new Error(result.stderr.toString());
};

async function housekeepingHome() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "quench-cli-ui-housekeeping-")));
  const repo = join(dir, "code/app");
  const tree = (name: string) => join(dir, "wt", name);
  await mkdir(repo, { recursive: true });
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "init");
  for (const name of ["merged", "dirty"]) git(repo, "worktree", "add", "-b", name, tree(name));
  await Bun.write(join(tree("dirty"), "notes.txt"), "draft\n");
  await Bun.write(join(repo, ".env"), `GITHUB_TOKEN=${CANARY}\n`);
  await Bun.write(
    join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: CANARY } } } }),
  );
  await Bun.write(
    join(dir, ".claude/projects/app/s1.jsonl"),
    lines([
      {
        type: "user",
        sessionId: "s1",
        cwd: repo,
        timestamp: at(9),
        message: { role: "user", content: `use GITHUB_TOKEN=${CANARY} for the push` },
      },
      {
        type: "assistant",
        sessionId: "s1",
        cwd: repo,
        timestamp: at(8),
        message: {
          id: "m1",
          model: "model-x",
          content: [{ type: "text", text: `Exported ${CANARY}.` }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]),
  );
  return { dir, repo, tree };
}

async function sameEnvQuench(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

const withoutClock = (report: { observedAt?: string }) => ({ ...report, observedAt: null });

test(
  "/api/worktrees and /api/secrets equal their CLI --json, and the canary value never reaches the page",
  async () => {
    const { dir, tree } = await housekeepingHome();
    const cliWorktrees = await quench(dir, "worktrees", "--json");
    const cliSecrets = await sameEnvQuench(dir, "secrets", "--json", "--no-host-history");
    expect(cliWorktrees.code).toBe(0);
    expect(cliSecrets.code).toBe(0);
    const worktrees = JSON.parse(cliWorktrees.stdout);
    expect(
      worktrees.repositories[0].worktrees.map((w: { path: string; removable: boolean }) => [
        w.path,
        w.removable,
      ]),
    ).toEqual([
      [tree("dirty"), false],
      [tree("merged"), true],
    ]);
    const secrets = JSON.parse(cliSecrets.stdout);
    expect(secrets.history.secrets.length).toBeGreaterThan(0);
    expect(secrets.configs.length).toBeGreaterThan(0);
    expect(cliSecrets.stdout).not.toContain(CANARY);

    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
      judge: null,
    });
    if (running instanceof Error) throw running;
    try {
      const served = {
        worktrees: await get(running.port, "/api/worktrees"),
        secrets: await get(running.port, "/api/secrets"),
      };
      for (const response of Object.values(served)) {
        expect(response.status).toBe(200);
        expect(response.headers["content-security-policy"]).toBe(CSP);
      }
      expect(withoutClock(JSON.parse(served.worktrees.body))).toEqual(withoutClock(worktrees));
      expect(withoutClock(JSON.parse(served.secrets.body))).toEqual(withoutClock(secrets));
      expect(served.secrets.body).toContain(`${CANARY.slice(0, 4)}…`);

      const assets = await uiAssets();
      const everything = [
        "/",
        "/api/skills",
        "/api/worktrees",
        "/api/secrets",
        ...[...assets.keys()].map((name) => `/${name}`),
      ];
      for (const path of everything) {
        const { body } = await get(running.port, path);
        expect(body).not.toContain(CANARY);
        expect(body).not.toContain(CANARY.slice(4));
      }
      expect(await Bun.file(join(tree("merged"), ".git")).exists()).toBe(true);
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

test("with judging off, /api/corrections says so without reading history", async () => {
  const running = await startUi(new Home(await mkdtemp(join(tmpdir(), "quench-cli-ui-"))), {
    days: 30,
    cache: true,
    open: false,
    hostHistory: false,
    judge: provider({ name: "none" }),
  });
  if (running instanceof Error) throw running;
  try {
    expect(JSON.parse((await get(running.port, "/api/corrections")).body)).toEqual({
      judge: null,
    });
  } finally {
    await running.stop();
  }
});

test("a burst of reloads starts at most one scan; ?refresh=1 or an old result starts one more", async () => {
  let reads = 0;
  const pending: ((value: string) => void)[] = [];
  const read = () => {
    reads++;
    return reads === 1
      ? Promise.resolve("first")
      : new Promise<string>((done) => {
          pending.push(done);
        });
  };
  const slow = serveUi({ port: 0, api: { report: lastResult(read, 300) }, assets });
  const burst = (path: string) =>
    Promise.all(Array.from({ length: 10 }, () => get(slow.port, path)));
  try {
    await Bun.sleep(50);
    expect(reads).toBe(0);
    const first = await get(slow.port, "/api/report");
    expect(JSON.parse(first.body)).toBe("first");
    expect(first.headers["x-quench-refreshing"]).toBe("false");
    for (const response of await burst("/api/report")) {
      expect(JSON.parse(response.body)).toBe("first");
      expect(response.headers["x-quench-refreshing"]).toBe("false");
      expect(response.headers["x-quench-computed-at"]).toBe(first.headers["x-quench-computed-at"]);
    }
    expect(reads).toBe(1);
    const asked = await burst("/api/report?refresh=1");
    expect(reads).toBe(2);
    for (const response of asked) {
      expect(JSON.parse(response.body)).toBe("first");
      expect(response.headers["x-quench-refreshing"]).toBe("true");
      expect(response.headers["content-security-policy"]).toBe(CSP);
    }
    pending.shift()!("second");
    await Bun.sleep(10);
    await burst("/api/report");
    expect(reads).toBe(2);
    expect(JSON.parse((await get(slow.port, "/api/report")).body)).toBe("second");
    await Bun.sleep(350);
    await burst("/api/report");
    expect(reads).toBe(3);
  } finally {
    await slow.stop();
  }
});

test(
  "no secrets scan starts until /api/secrets is requested, even after warming",
  async () => {
    const { dir } = await housekeepingHome();
    const key = join(dir, ".quench/local/secrets.key");
    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
      judge: null,
    });
    if (running instanceof Error) throw running;
    try {
      await running.warm();
      await get(running.port, "/");
      await Bun.sleep(200);
      expect(await Bun.file(key).exists()).toBe(false);
      expect((await get(running.port, "/api/secrets")).status).toBe(200);
      expect(await Bun.file(key).exists()).toBe(true);
    } finally {
      await running.stop();
    }
  },
  cliRunsTimeout,
);

test("a refresh that keeps failing is retried once per interval, not on every poll, and its error is served beside the old result", async () => {
  let reads = 0;
  const read = () =>
    ++reads === 1 ? Promise.resolve("first") : Promise.reject(new Error("scan failed: disk gone"));
  const flaky = serveUi({ port: 0, api: { report: lastResult(read, 50) }, assets });
  try {
    await get(flaky.port, "/api/report");
    await Bun.sleep(60);
    const polls = [];
    for (let i = 0; i < 5; i++) {
      polls.push(await get(flaky.port, "/api/report"));
      await Bun.sleep(5);
    }
    expect(reads).toBe(2);
    const last = polls.at(-1)!;
    expect(JSON.parse(last.body)).toBe("first");
    expect(last.headers["x-quench-refreshing"]).toBe("false");
    expect(decodeURIComponent(last.headers["x-quench-refresh-error"] as string)).toBe(
      "scan failed: disk gone",
    );
    await Bun.sleep(60);
    await get(flaky.port, "/api/report");
    expect(reads).toBe(3);
  } finally {
    await flaky.stop();
  }
});
