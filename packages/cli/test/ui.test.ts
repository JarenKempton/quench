import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { CSP, lastResult, serveUi, startUi, uiAssets } from "../src/commands/ui.ts";
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
  api: { skills: async () => ({ skills: [] }) },
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
  for (const path of ["/", "/api/skills", "/missing.js"]) {
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
    const response = await get(server.port, "/api/skills", host);
    expect(response.status).toBe(421);
    expect(response.body).not.toContain("skills");
  }
});

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
  "/api/skills equals quench skills --json on the same home, and each request reads it again",
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
    });
    if (running instanceof Error) throw running;
    try {
      expect(running.url).toStartWith("http://127.0.0.1:");
      const served = await get(running.port, "/api/skills");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(JSON.parse(served.body)).toEqual(JSON.parse(expected.stdout));
      await Bun.write(
        join(dir, ".claude/skills/tidy/SKILL.md"),
        "---\nname: tidy\ndescription: tidy\n---\n",
      );
      const again = JSON.parse((await get(running.port, "/api/skills")).body);
      expect(again.skills.map((r: { skill: string }) => r.skill)).toContain("tidy");
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

test("a slow report is computed on first request only, then served at once with its age while one refresh runs", async () => {
  let reads = 0;
  let finish = (_: string) => {};
  const read = () => {
    reads++;
    return reads === 1
      ? Promise.resolve("first")
      : new Promise<string>((done) => {
          finish = done;
        });
  };
  const slow = serveUi({ port: 0, api: { report: lastResult(read) }, assets });
  try {
    await Bun.sleep(50);
    expect(reads).toBe(0);
    const first = await get(slow.port, "/api/report");
    expect(JSON.parse(first.body)).toBe("first");
    expect(first.headers["x-quench-refreshing"]).toBe("false");
    expect(Date.parse(first.headers["x-quench-computed-at"] as string)).toBeLessThanOrEqual(
      Date.now(),
    );
    const [again, alongside] = await Promise.all([
      get(slow.port, "/api/report"),
      get(slow.port, "/api/report"),
    ]);
    for (const response of [again, alongside]) {
      expect(JSON.parse(response.body)).toBe("first");
      expect(response.headers["x-quench-refreshing"]).toBe("true");
      expect(response.headers["content-security-policy"]).toBe(CSP);
    }
    expect(reads).toBe(2);
    finish("second");
    await Bun.sleep(10);
    const fresh = await get(slow.port, "/api/report");
    expect(JSON.parse(fresh.body)).toBe("second");
  } finally {
    await slow.stop();
  }
});

test(
  "no secrets scan starts until /api/secrets is requested",
  async () => {
    const { dir } = await housekeepingHome();
    const key = join(dir, ".quench/local/secrets.key");
    const running = await startUi(new Home(dir), {
      days: 30,
      cache: true,
      open: false,
      hostHistory: false,
    });
    if (running instanceof Error) throw running;
    try {
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
