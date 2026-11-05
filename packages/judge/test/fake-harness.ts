import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = process.env.FAKE_DIR ?? dirname(process.execPath);
const config = JSON.parse(readFileSync(join(dir, "fake.json"), "utf8")) as {
  mode?: string;
  answer?: string;
  marker?: string;
  bun?: string;
  stderr?: string;
};
const argv = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const mode = config.mode ?? "ok";
appendFileSync(
  join(dir, "log.jsonl"),
  `${JSON.stringify({ argv, stdin, cwd: process.cwd(), env: Object.keys(process.env) })}\n`,
);
if (mode === "exit") {
  process.stderr.write(config.stderr ?? "not logged in\n");
  process.exit(3);
}
if (mode === "slow") await Bun.sleep(2_000);
if (mode === "linger")
  Bun.spawn(
    [
      config.bun ?? "bun",
      "-e",
      `await Bun.sleep(2500); require("fs").writeFileSync(${JSON.stringify(config.marker)}, "")`,
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  ).unref();
const answer = config.answer ?? "";
process.stdout.write(
  mode === "raw"
    ? answer
    : JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }),
);
