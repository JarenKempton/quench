import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, quench } from "./run.ts";

const token = ["ghp", "R7tK2mQ9xV4bN8cL1zW6yH3jF5dS0aP2eG7u"].join("_");
const hook = "PreToolUse:Bash hook error: [guard.sh]: guard: blocked";

type Repro = { name: string; command: string; output: string; leaks: string[]; blocked?: true };

const repros: Repro[] = [
  {
    name: "curl -u user:pass",
    command: "curl -u user:qrevq https://example.test",
    output: "Exit code 22\n+ curl -u user:qrevq https://example.test",
    leaks: ["qrevq"],
  },
  {
    name: "curl -u with a two-letter pair",
    command: "curl -u qa:qb https://example.test",
    output: "Exit code 22\n+ curl -u qa:qb",
    leaks: ["qa:qb"],
  },
  {
    name: "short URL password",
    command: "git clone https://user:qz@example.test/r.git",
    output: "Exit code 128\nremote: auth failed for https://user:qz@example.test",
    leaks: [":qz@"],
  },
  {
    name: "token as the URL username",
    command: "git clone https://qutokq:x-oauth-basic@example.test/r.git",
    output: "Exit code 128\nfatal: https://qutokq:x-oauth-basic@example.test denied",
    leaks: ["qutokq"],
  },
  {
    name: "Authorization with no space",
    command: "curl -H Authorization:qvzx https://example.test",
    output: "Exit code 22\n> Authorization:qvzx rejected",
    leaks: ["qvzx"],
  },
  {
    name: "Cookie and X-Api-Key headers",
    command: "curl -H 'Cookie: session=qckq' -H 'X-Api-Key: qxakq' https://example.test",
    output: "Exit code 22\n> Cookie: session=qckq\n> X-Api-Key: qxakq",
    leaks: ["qckq", "qxakq"],
  },
  {
    name: "escaped quotes",
    command: 'curl -H "Authorization: Bearer \\"qescq\\"" https://example.test',
    output: 'Exit code 22\n> Authorization: Bearer \\"qescq\\"',
    leaks: ["qescq"],
  },
  {
    name: "quote context lost across the first line",
    command: "deploy --token 'qlnq",
    output: "Exit code 1\n' rejected\nqlnq'",
    leaks: ["qlnq"],
  },
  {
    name: "short JSON password",
    command: `curl -d '{"password":"qj"}' https://example.test`,
    output: 'Exit code 22\n{"password":"qj"} rejected',
    leaks: ['"qj"'],
  },
  {
    name: "credential positional",
    command: "oathtool qdbq",
    output: "Exit code 1\noathtool: qdbq: invalid",
    leaks: ["qdbq"],
  },
  {
    name: "KEY=value assignment",
    command: "API_KEY=qenvq node run.js",
    output: "Exit code 1\nrefused API_KEY=qenvq",
    leaks: ["qenvq"],
  },
  {
    name: "known token prefix",
    command: `gh api user --header "x-token: ${token}"`,
    output: `Exit code 1\ngh: bad credentials for ${token}`,
    leaks: [token],
  },
  {
    name: "--token values starting with a dash",
    command: "deploy --token=-qdashq --token -qdshq",
    output: "Exit code 1\nrejected --token=-qdashq --token -qdshq",
    leaks: ["qdashq", "qdshq"],
  },
  {
    name: "short --password beside unrelated text",
    command: "deploy --password=qpq bypass",
    output: "Exit code 1\nrejected --password=qpq bypass",
    leaks: ["qpq"],
  },
  {
    name: "mixed and overlapping credentials",
    command: `deploy --password=https://u:qoqa@example.test -H "Authorization: Bearer ${token}" -u qmqa:qmqb`,
    output: `Exit code 1\n--password=https://u:qoqa@example.test Authorization: Bearer ${token} TOKEN=qmqf`,
    leaks: ["qoqa", token, "qmqa", "qmqb", "qmqf"],
  },
  {
    name: "hook refusal naming a user:pass@host URL",
    command: "git push https://user:qhrq@example.test/r.git",
    output: `${hook} https://user:qhrq@example.test`,
    leaks: ["qhrq"],
    blocked: true,
  },
  {
    name: "hook refusal of a chained command carrying secrets",
    command:
      "cd x && env -u GITHUB_TOKEN TOKEN=qcvq git commit -m 'qcmq' && git push https://u:qcpq@h",
    output: `${hook} — push to main`,
    leaks: ["qcvq", "qcmq", "qcpq"],
    blocked: true,
  },
  {
    name: "hook refusal quoting a token and short credentials",
    command: "gh api user",
    output: `${hook} — ${token} -u qhqa:qhqb Authorization:qhqc {"password":"qhqd"}`,
    leaks: [token, "qhqa", "qhqb", "qhqc", "qhqd"],
    blocked: true,
  },
];

test("no credential from a command, error or refusal reaches profile, steering, JSON or cache", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-failure-secrets-")));
  const project = join(home, "work");
  await mkdir(project, { recursive: true });
  const record = (r: Repro, n: number) => [
    {
      type: "assistant",
      cwd: project,
      message: {
        content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: r.command } }],
      },
    },
    {
      type: "user",
      cwd: project,
      ...(r.blocked ? { permissionDecision: { decision: "reject", source: "hook" } } : {}),
      message: {
        content: [{ type: "tool_result", tool_use_id: `t${n}`, content: r.output, is_error: true }],
      },
    },
  ];
  for (const id of ["one", "two"])
    await Bun.write(
      join(home, `.claude/projects/p/${id}.jsonl`),
      lines(repros.flatMap((r, n) => record(r, n))),
    );
  const table = await quench(home, "profile", "failures");
  expect(table.code).toBe(0);
  const json = (await quench(home, "profile", "--json")).stdout;
  const failures = JSON.parse(json).recordedFailures;
  expect(failures.failures).toBe(2 * repros.length);
  expect(failures.blocked.length).toBeGreaterThan(0);
  expect(failures.repeated.length).toBeGreaterThan(0);
  const steering = await quench(home, "steering", project);
  expect(steering.stdout).toContain("PreToolUse:Bash hook guard.sh · git push");
  expect(steering.stdout).toContain("PreToolUse:Bash hook guard.sh · several commands");
  const steeringJson = (await quench(home, "steering", project, "--json")).stdout;
  const cache = await Bun.file(join(home, ".quench/local/session-places.json")).text();
  const outputs = { table: table.stdout, json, steering: steering.stdout, steeringJson, cache };
  const found = Object.entries(outputs).flatMap(([where, text]) =>
    repros.flatMap((r) =>
      r.leaks.filter((leak) => text.includes(leak)).map((l) => `${where}: ${l}`),
    ),
  );
  expect(found).toEqual([]);
});
