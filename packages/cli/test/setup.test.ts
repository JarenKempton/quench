import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANNED_EXCHANGE } from "@quench/judge";

const root = join(import.meta.dir, "../../..");
const fixture = join(root, "packages/history/test/fixtures/home");
const posix = process.platform !== "win32";

const bodies: string[] = [];
let answer = '{"kind":"correction","sender":"person","confidence":0.9}';
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    bodies.push(await request.text());
    return Response.json({
      choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
    });
  },
});
afterAll(() => server.stop(true));
const baseUrl = `http://127.0.0.1:${server.port}/v1`;

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), "quench-setup-"));
  await cp(fixture, home, { recursive: true });
  return home;
}

async function quench(home: string, args: string[], stdin = "", extra = {}) {
  const proc = Bun.spawn([process.execPath, join(root, "packages/cli/src/main.ts"), ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: "",
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
      QUENCH_JUDGE: "",
      QUENCH_OPENAI_BASE_URL: "",
      QUENCH_OPENAI_MODEL: "",
      QUENCH_OPENAI_API_KEY: "",
      ...extra,
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const config = (home: string) => Bun.file(join(home, ".quench/config.json")).json();
const mode = async (home: string) => (await stat(join(home, ".quench/config.json"))).mode & 0o777;

test("setup --judge none --yes runs without a terminal, a hub or a key, and resumes", async () => {
  const home = await freshHome();
  const run = await quench(home, ["setup", "--judge", "none", "--yes"]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Step 1/5 · Your agents");
  expect(run.stdout).toMatch(/Claude Code\s+1 session over \d+ days?, in /);
  expect(run.stdout).toContain(`, in ${join("~", ".claude")}\n`);
  expect(run.stdout).toContain("Step 2/5 · What your sessions start with");
  expect(run.stdout).toContain("No judge: quench corrections stays off");
  expect(run.stdout).toContain("Not available yet: hub pairing arrives with quench connect");
  expect(run.stdout).toContain("Setup finished; skipped: hub, ui.");
  expect(await config(home)).toEqual({
    judge: { name: "none" },
    setup: { done: ["agents", "summary", "judge"] },
  });
  if (posix) expect(await mode(home)).toBe(0o600);

  const again = await quench(home, ["setup", "--yes"]);
  expect(again.code).toBe(0);
  expect(again.stdout).not.toContain("Step 1/5");
  expect(again.stdout).toContain("Step 4/5 · Pair with a hub");

  const off = await quench(home, ["corrections"]);
  expect(off.code).toBe(2);
  expect(off.stderr).toContain("Reply classification is off: the judge is none");
  for (const args of [["report", "--days", "36500"], ["profile"], ["steering", home]])
    expect((await quench(home, args)).code).toBe(0);
  const dry = await quench(home, ["corrections", "--judge", "jev", "--dry-run", "--json"]);
  expect(JSON.parse(dry.stdout).judge).toStartWith("jev/");
});

test("setup tests an OpenAI-compatible judge on a canned exchange and keeps its key in a 0600 file", async () => {
  const home = await freshHome();
  bodies.length = 0;
  answer = '{"kind":"correction","sender":"person","confidence":0.9}';
  const typed = `openai\n${baseUrl}\nsmall-model\nsk-local-test\n`;
  const run = await quench(home, ["setup", "judge"], typed);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  const id = `openai/${baseUrl}/small-model/reply-v1`;
  expect(run.stdout).toContain(`Test passed: ${id} answered "correction"`);
  expect(run.stdout).not.toContain("sk-local-test");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain(JSON.stringify(CANNED_EXCHANGE.reply).slice(1, -1));
  expect(bodies[0]).not.toContain("health check");
  expect((await config(home)).judge).toEqual({
    name: "openai",
    baseUrl,
    model: "small-model",
    apiKey: "sk-local-test",
  });
  if (posix) expect(await mode(home)).toBe(0o600);

  const dry = await quench(home, ["corrections", "--days", "36500", "--dry-run", "--json"]);
  expect(JSON.parse(dry.stdout).judge).toBe(id);
  const overridden = await quench(home, ["corrections"], "", { QUENCH_JUDGE: "none" });
  expect(overridden.code).toBe(2);
});

test("a judge that fails its test is not saved", async () => {
  const home = await freshHome();
  answer = "probably a correction";
  const env = { QUENCH_OPENAI_BASE_URL: baseUrl, QUENCH_OPENAI_MODEL: "small-model" };
  const run = await quench(home, ["setup", "judge", "--judge", "openai", "--yes"], "", env);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("Test failed: OpenAI-compatible judge unparseable");
  expect(run.stdout).toContain("Setup stopped at judge. Run quench setup to resume there.");
  expect(await Bun.file(join(home, ".quench/config.json")).exists()).toBe(false);
});

test("setup stops cleanly without answers, and rejects unknown steps and judges", async () => {
  const home = await freshHome();
  const run = await quench(home, ["setup", "judge"]);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("Setup stopped at judge");
  const jev = await quench(home, ["setup", "judge", "--judge", "jev", "--yes"]);
  expect(jev.code).toBe(1);
  expect(jev.stdout).toContain("Jev needs a TypeSafe API key");
  expect((await quench(home, ["setup", "nope"])).stderr).toContain('unknown setup step "nope"');
  expect((await quench(home, ["setup", "--judge", "gpt"])).stderr).toContain(
    "--judge must be jev, claude, openai or none",
  );
});

test.skipIf(posix)("setup on Windows never offers claude", async () => {
  const home = await freshHome();
  const run = await quench(home, ["setup", "judge"], "claude\nskip\n");
  expect(run.stdout).not.toContain("claude -p, signed in as you");
  expect(run.stdout).toContain("Pick one of jev, openai, none, or skip.");
  expect(run.code).toBe(0);
});

const CANARY = "CANARY9e2f";

test("an explicit --judge none beats QUENCH_JUDGE and never calls a model", async () => {
  const home = await freshHome();
  bodies.length = 0;
  const env = {
    QUENCH_JUDGE: "openai",
    QUENCH_OPENAI_BASE_URL: baseUrl,
    QUENCH_OPENAI_MODEL: "small-model",
  };
  const run = await quench(home, ["setup", "judge", "--judge", "none", "--yes"], "", env);
  expect(run.code).toBe(0);
  expect((await config(home)).judge).toEqual({ name: "none" });
  const off = await quench(home, ["corrections", "--judge", "none"], "", env);
  expect(off.code).toBe(2);
  expect(bodies).toHaveLength(0);
});

test("a malformed key or a remote plain-HTTP endpoint is refused without leaking or sending", async () => {
  const home = await freshHome();
  bodies.length = 0;
  const bad = {
    QUENCH_OPENAI_BASE_URL: baseUrl,
    QUENCH_OPENAI_MODEL: "small-model",
    QUENCH_OPENAI_API_KEY: `sk-${CANARY}\u0007`,
  };
  const remote = {
    ...bad,
    QUENCH_OPENAI_BASE_URL: "http://api.example.com/v1",
    QUENCH_OPENAI_API_KEY: `sk-${CANARY}`,
  };
  for (const env of [bad, remote]) {
    const runs = [
      await quench(home, ["setup", "judge", "--judge", "openai", "--yes"], "", env),
      await quench(home, ["corrections", "--judge", "openai", "--json"], "", env),
      await quench(home, ["corrections", "--judge", "openai", "--dry-run", "--json"], "", env),
    ];
    for (const run of runs) {
      expect(run.code).toBe(1);
      expect(run.stdout + run.stderr).not.toContain(CANARY);
    }
  }
  await typedBadKey(home);
  expect(bodies).toHaveLength(0);
});

const typedBadKey = async (home: string) => {
  const typed = `openai\n${baseUrl}\nsmall-model\nsk-${CANARY}\u0001\nskip\n`;
  const run = await quench(home, ["setup", "judge"], typed);
  expect(run.stdout + run.stderr).not.toContain(CANARY);
  expect(run.stdout).toContain("API key has characters a header cannot carry");
  expect(await Bun.file(join(home, ".quench/config.json")).text()).not.toContain(CANARY);
};

test.skipIf(!posix)(
  "in a terminal, a typed key is not echoed and setup exits once it finishes",
  async () => {
    const home = await freshHome();
    answer = '{"kind":"correction","sender":"person","confidence":0.9}';
    let screen = "";
    const proc = Bun.spawn(
      [process.execPath, join(root, "packages/cli/src/main.ts"), "setup", "judge"],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: "",
          CLAUDE_CONFIG_DIR: "",
          CODEX_HOME: "",
          PI_CODING_AGENT_DIR: "",
          TYPESAFE_API_KEY: "",
          QUENCH_JUDGE: "",
          QUENCH_OPENAI_BASE_URL: "",
          QUENCH_OPENAI_MODEL: "",
          QUENCH_OPENAI_API_KEY: "",
        },
        terminal: {
          cols: 200,
          rows: 50,
          data(_terminal, bytes) {
            screen += new TextDecoder().decode(bytes);
          },
        },
      },
    );
    const type = async (prompt: string, text: string) => {
      for (let i = 0; i < 200 && !screen.includes(prompt); i++) await Bun.sleep(25);
      expect(screen).toContain(prompt);
      proc.terminal?.write(text);
    };
    await type("Judge [none]", "openai\r");
    await type("Base URL", `${baseUrl}\r`);
    await type("Model", "small-model\r");
    await type("API key", `sk-${CANARY}\r`);
    const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "hung")]);
    if (exited === "hung") proc.kill();
    expect(exited).toBe(0);
    expect(screen).toContain("Setup finished");
    expect(screen).not.toContain(CANARY);
    expect((await config(home)).judge.apiKey).toBe(`sk-${CANARY}`);
  },
  20_000,
);
