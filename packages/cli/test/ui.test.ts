import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { provider, type Provider } from "@quench/judge";
import { Aged, CSP, lastResult, serveUi, startUi } from "../src/commands/ui.ts";
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
    "/api/skills": async () => ({ skills: [] }),
    "/api/corrections": async () => ({ judge: null }),
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
  for (const path of ["/", "/api/skills", "/api/corrections", "/missing.js"]) {
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
    for (const path of ["/api/skills", "/api/corrections"]) {
      const response = await get(server.port, path, host);
      expect(response.status).toBe(421);
      expect(response.body).not.toContain("skills");
      expect(response.body).not.toContain("judge");
    }
  }
});

test("an API answer that takes longer than Bun's 10 s idle timeout still arrives", async () => {
  const slow = serveUi({
    port: 0,
    api: { "/api/corrections": () => Bun.sleep(15_000).then(() => ({ judge: null })) },
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

test("lastResult keeps the last answer until it is too old or a refresh is asked, sharing one run", async () => {
  let clock = 0;
  let reads = 0;
  let release = () => {};
  const read = lastResult(
    () => {
      reads++;
      return new Promise((done) => (release = () => done(reads)));
    },
    1000,
    () => clock,
  );
  const first = [read(false), read(false), read(true)];
  release();
  const answers = await Promise.all(first);
  expect(reads).toBe(1);
  expect(answers.map((a) => a.value)).toEqual([1, 1, 1]);
  expect(answers[0]).toBeInstanceOf(Aged);
  clock = 1000;
  expect((await read(false)).value).toBe(1);
  const refreshed = read(true);
  release();
  expect((await refreshed).value).toBe(2);
  clock = 2001;
  const stale = read(false);
  release();
  expect(await stale).toMatchObject({ value: 3, computedAt: new Date(2001) });
});

test("?refresh=1 reaches the API, and its computed time is sent", async () => {
  const asked: boolean[] = [];
  const served = serveUi({
    port: 0,
    api: {
      "/api/corrections": async (refresh) => {
        asked.push(refresh);
        return new Aged({ ok: true }, new Date(5));
      },
    },
    assets,
  });
  try {
    await get(served.port, "/api/corrections");
    const again = await get(served.port, "/api/corrections?refresh=1");
    expect(asked).toEqual([false, true]);
    expect(again.headers["x-quench-computed-at"]).toBe(new Date(5).toISOString());
    expect(JSON.parse(again.body)).toEqual({ ok: true });
  } finally {
    await served.stop();
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
      judge: null,
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
