import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const mode = process.env.FAKE_MODE ?? "ok";
const log = process.env.FAKE_LOG;
if (log)
  appendFileSync(
    log,
    `${JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      child: process.env.QUENCH_CLASSIFIER_CHILD ?? null,
      claudecode: process.env.CLAUDECODE ?? null,
    })}\n`,
  );
if (mode === "exit") {
  process.stderr.write("not logged in\n");
  process.exit(3);
}
if (mode === "slow") await Bun.sleep(2_000);
if (mode === "linger")
  Bun.spawn(
    [
      process.env.FAKE_BUN ?? "bun",
      "-e",
      `await Bun.sleep(2500); require("fs").writeFileSync(${JSON.stringify(process.env.FAKE_MARKER)}, "")`,
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  ).unref();
const answer = process.env.FAKE_ANSWER ?? "";
process.stdout.write(
  mode === "raw"
    ? answer
    : JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }),
);
