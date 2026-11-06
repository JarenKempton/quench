import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { day, fixture, git } from "./correction-home.ts";

const bin = process.argv.slice(2);
const runs = 15;
const home = await fixture();
const work = join(home, "work");
const extra = Array.from({ length: 20 }, (_, i) => join(work, `d${i}`, "CLAUDE.md"));
for (const [n, at] of [day(1, 2), day(1, 20), day(2, 5)].entries()) {
  for (const file of extra) {
    await mkdir(join(file, ".."), { recursive: true });
    await Bun.write(file, `rule ${n}\n`.repeat(n + 1));
  }
  await git(work, at, "add", ".");
  await git(work, at, "commit", "-q", "-m", `extra ${n}`);
}
const dir = join(home, ".claude/projects/-work");
for (const name of await readdir(dir)) {
  if (!name.endsWith(".jsonl")) continue;
  const lines = (await Bun.file(join(dir, name)).text()).trim().split("\n");
  const first = JSON.parse(lines[0]!);
  first.attachment.files.push(...extra.map((path) => ({ path, type: "Project", content: "x" })));
  lines[0] = JSON.stringify(first);
  await Bun.write(join(dir, name), `${lines.join("\n")}\n`);
}
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: "",
  CODEX_HOME: "",
  PI_CODING_AGENT_DIR: "",
  TYPESAFE_API_KEY: "must-not-be-used",
  TYPESAFE_BASE_URL: "http://127.0.0.1:1",
};
const commands = [
  ["--version"],
  ["report", "--json", "--days", "3650"],
  ["corrections", "--context", "--cached-only", "--dry-run", "--json", "--days", "3650"],
];
const rows = [];
for (const args of commands) {
  const times: number[] = [];
  let out = "";
  for (let i = 0; i < runs + 1; i++) {
    const start = performance.now();
    const result = Bun.spawnSync([...bin, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const ms = performance.now() - start;
    if (!result.success) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    out = result.stdout.toString();
    if (i) times.push(ms);
  }
  times.sort((a, b) => a - b);
  rows.push({
    command: `quench ${args.join(" ")}`,
    medianMs: Math.round(times[Math.floor(times.length / 2)]!),
    minMs: Math.round(times[0]!),
    outBytes: out.length,
  });
}
await rm(home, { recursive: true, force: true });
console.log(JSON.stringify({ os: process.platform, bin: bin.join(" "), rows }));
