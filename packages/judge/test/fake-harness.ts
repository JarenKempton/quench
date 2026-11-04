import { appendFileSync, writeFileSync } from "node:fs";

const [name = "", ...argv] = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const mode = process.env.FAKE_MODE ?? "ok";
const log = process.env.FAKE_LOG;
if (log)
  appendFileSync(
    log,
    `${JSON.stringify({
      name,
      argv,
      stdin,
      cwd: process.cwd(),
      child: process.env.QUENCH_CLASSIFIER_CHILD ?? null,
      claudecode: process.env.CLAUDECODE ?? null,
    })}\n`,
  );
const answer = mode === "garbage" ? "I think it is a correction." : (process.env.FAKE_ANSWER ?? "");
if (mode === "exit") {
  process.stderr.write("not logged in\n");
  process.exit(3);
}
if (mode === "slow") await Bun.sleep(2_000);
if (name === "codex") {
  const out = argv[argv.indexOf("-o") + 1];
  if (out) writeFileSync(out, answer);
} else {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: answer }));
}
