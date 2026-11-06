import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { CSP, serveUi, startUi } from "../src/commands/ui.ts";
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
