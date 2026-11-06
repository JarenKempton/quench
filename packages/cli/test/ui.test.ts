import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { CSP, serveUi } from "../src/commands/ui.ts";
import { cliRunsTimeout, lines, quench } from "./run.ts";

const main = join(import.meta.dir, "../src/main.ts");

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
const server = serveUi({ port: 0, skills: async () => ({ skills: [] }), assets });
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
  "quench ui serves /api/skills equal to quench skills --json on the same home",
  async () => {
    const dir = await home();
    const expected = await quench(dir, "skills", "--json", "--no-host-history");
    expect(expected.code).toBe(0);
    expect(JSON.parse(expected.stdout).skills.length).toBe(2);
    const proc = Bun.spawn(["bun", main, "ui", "--no-host-history"], {
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_CONFIG_DIR: "",
        CODEX_HOME: "",
        PI_CODING_AGENT_DIR: "",
      },
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const reader = proc.stdout.getReader();
      let printed = "";
      while (!/http:\/\/\S+\//.test(printed)) {
        const { value, done } = await reader.read();
        if (done) break;
        printed += new TextDecoder().decode(value);
      }
      const url = new URL(/http:\/\/\S+\//.exec(printed)![0]);
      expect(url.hostname).toBe("127.0.0.1");
      const served = await get(Number(url.port), "/api/skills");
      expect(served.status).toBe(200);
      expect(served.headers["content-security-policy"]).toBe(CSP);
      expect(JSON.parse(served.body)).toEqual(JSON.parse(expected.stdout));
    } finally {
      proc.kill();
      await proc.exited;
    }
  },
  cliRunsTimeout,
);
