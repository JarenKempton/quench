import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HARNESSES, owned, Snapshot, SkillReport, type Plan } from "@quench/fleet";
import { readLedger, type ApplyInput } from "@quench/fleet/apply";
import type { Home } from "@quench/history";
import { SCHEMA_VERSION } from "../skills/records.ts";
import { withVersions } from "../skills/versions.ts";
import {
  absolute,
  collectSkills,
  skillsApply,
  skillsPlan,
  stateDir,
  type SkillsOptions,
} from "./skills.ts";

export const SKILL_DAYS = 30;

export type AgentOptions = SkillsOptions & { interval: number; homeFlags: string[] };

export const statusFile = (home: Home) => join(stateDir(home), "status.json");

async function previousGeneration(home: Home) {
  const text = await readFile(statusFile(home), "utf8").catch(() => null);
  const parsed = text ? Snapshot.safeParse(JSON.parse(text).snapshot) : null;
  return parsed?.success ? parsed.data.generation : 0;
}

async function skillReport(
  home: Home,
  ledger: Awaited<ReturnType<typeof readLedger>>,
): Promise<SkillReport> {
  const { judge, records, unrecognised, evidence } = await collectSkills(home, {
    days: SKILL_DAYS,
    cache: true,
  });
  return SkillReport.parse({
    schemaVersion: SCHEMA_VERSION,
    days: SKILL_DAYS,
    judge,
    records: withVersions(records, ledger, evidence, (path) => absolute(home, path)),
    unrecognised,
  });
}

function snapshotOf(
  plan: Plan | null,
  ledger: Awaited<ReturnType<typeof readLedger>>,
  generation: number,
  skills: SkillReport | null,
): Snapshot {
  const mine = owned(ledger);
  const harnesses: Snapshot["harnesses"] = {};
  for (const harness of HARNESSES) {
    const items = plan?.items.filter((i) => i.harness === harness) ?? [];
    harnesses[harness] = {
      complete: plan !== null,
      conflicts: items.filter((i) => i.action === "conflict").length,
      installs: items.flatMap((i) => {
        if (!i.path || !i.installed) return [];
        const ours = mine.get(i.path);
        return [
          {
            skill: i.skill,
            path: i.path,
            location:
              i.location.scope === "project"
                ? {
                    scope: "project" as const,
                    remote: i.location.remote,
                    checkout: i.location.checkout ?? "",
                  }
                : { scope: "global" as const },
            treeHash: i.installed.treeHash,
            state: !ours
              ? "foreign"
              : ours.treeHash === i.installed.treeHash
                ? "owned"
                : "modified",
          },
        ];
      }),
    };
  }
  return Snapshot.parse({
    version: 1,
    id: crypto.randomUUID(),
    generation,
    takenAt: new Date().toISOString(),
    revision: null,
    harnesses,
    ...(skills ? { skills } : {}),
  });
}

export async function agentCycle(
  home: Home,
  options: SkillsOptions,
  hooks: Pick<ApplyInput, "now"> = {},
) {
  const generation = (await previousGeneration(home)) + 1;
  let report;
  try {
    const outcome = await skillsApply(home, { ...options, planHash: null }, hooks);
    report = {
      error: null,
      recovered: outcome.recovered,
      planHash: outcome.plan.hash ?? null,
      applied: outcome.applied,
      conflicts: outcome.conflicts,
      notes: outcome.notes,
      plan: await skillsPlan(home, options),
    };
  } catch (error) {
    report = {
      error: (error as Error).message,
      recovered: null,
      planHash: null,
      applied: [],
      conflicts: [],
      notes: [],
      plan: null,
    };
  }
  const { plan, ...rest } = report;
  const ledger = await readLedger(stateDir(home));
  let skills: SkillReport | null = null;
  let skillsError: string | null = null;
  try {
    skills = await skillReport(home, ledger);
  } catch (error) {
    skillsError = (error as Error).message;
  }
  const status = {
    version: 1,
    source: resolve(options.source),
    machine: options.machine,
    ...rest,
    skillsError,
    snapshot: snapshotOf(plan, ledger, generation, skills),
  };
  const file = statusFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return status;
}

export async function agentRun(home: Home, options: AgentOptions & { once: boolean }) {
  for (;;) {
    const status = await agentCycle(home, options);
    process.stdout.write(
      `${status.snapshot.takenAt} ${status.error ? `error: ${status.error}` : `applied ${status.applied.length}, conflicts ${status.conflicts.length}`}\n`,
    );
    if (options.once) return status.error || status.conflicts.length ? 1 : 0;
    await Bun.sleep(options.interval * 1000);
  }
}

export const LABEL = "sh.quench.agent";
export const UNIT = "quench-agent.service";
export const TASK = "QuenchAgent";

export type Service = {
  file: string;
  contents: string | Uint8Array;
  install: string[][];
  uninstall: string[][];
};

const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const systemdArg = (s: string) =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(s)
    ? s.replaceAll("%", "%%")
    : `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

const windowsArg = (s: string) => (/^[^\s"]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`);

export function serviceFor(
  platform: NodeJS.Platform,
  home: Home,
  argv: string[],
  ids: { uid: number; user: string },
): Service {
  if (platform === "linux") {
    const file = join(home.dir, ".config/systemd/user", UNIT);
    return {
      file,
      contents: `[Unit]
Description=Quench agent: keeps this machine's skills applied

[Service]
ExecStart=${argv.map(systemdArg).join(" ")}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`,
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", UNIT],
      ],
      uninstall: [
        ["systemctl", "--user", "disable", "--now", UNIT],
        ["systemctl", "--user", "daemon-reload"],
      ],
    };
  }
  if (platform === "darwin") {
    const file = join(home.dir, "Library/LaunchAgents", `${LABEL}.plist`);
    const log = join(stateDir(home), "agent.log");
    return {
      file,
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`,
      install: [["launchctl", "bootstrap", `gui/${ids.uid}`, file]],
      uninstall: [["launchctl", "bootout", `gui/${ids.uid}/${LABEL}`]],
    };
  }
  if (platform === "win32") {
    const file = join(stateDir(home), "quench-agent.xml");
    const [command = "", ...args] = argv;
    const text = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Quench agent: keeps this machine's skills applied</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(ids.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(ids.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args.map(windowsArg).join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
    return {
      file,
      contents: new Uint8Array(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
      ),
      install: [
        ["schtasks", "/Create", "/TN", TASK, "/XML", file, "/F"],
        ["schtasks", "/Run", "/TN", TASK],
      ],
      uninstall: [
        ["schtasks", "/End", "/TN", TASK],
        ["schtasks", "/Delete", "/TN", TASK, "/F"],
      ],
    };
  }
  throw new Error(`agent install is not supported on ${platform}`);
}

export const selfCommand = () =>
  basename(process.execPath).replace(/\.exe$/, "") === "bun"
    ? [process.execPath, resolve(Bun.main)]
    : [process.execPath];

export type Exec = (command: string[]) => Promise<{ code: number; output: string }>;

export const exec: Exec = async (command) => {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}${err}`.trim() };
};

const identity = () => ({
  uid: process.getuid?.() ?? 0,
  user:
    process.platform === "win32"
      ? `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, "")
      : (process.env.USER ?? ""),
});

export async function agentInstall(
  home: Home,
  options: AgentOptions,
  run: Exec = exec,
  platform: NodeJS.Platform = process.platform,
) {
  const argv = [
    ...selfCommand(),
    "agent",
    "run",
    "--source",
    resolve(options.source),
    "--machine",
    options.machine,
    ...(options.projects ?? []).flatMap((p) => ["--project", resolve(p)]),
    "--interval",
    String(options.interval),
    ...options.homeFlags,
  ];
  const ids = identity();
  const service = serviceFor(platform, home, argv, ids);
  const warnings: string[] = [];
  if (platform === "darwin") await run(service.uninstall[0]!);
  await mkdir(dirname(service.file), { recursive: true });
  await writeFile(service.file, service.contents);
  for (const command of service.install) {
    const { code, output } = await run(command);
    if (code !== 0) throw new Error(`${command.join(" ")} failed: ${output}`);
  }
  if (platform === "linux") {
    const linger = await run(["loginctl", "show-user", ids.user, "--property=Linger", "--value"]);
    if (linger.output !== "yes")
      warnings.push(
        `linger is off for ${ids.user}: the agent stops when you log out. Run: loginctl enable-linger ${ids.user}`,
      );
  }
  return { file: service.file, warnings };
}

export async function agentUninstall(
  home: Home,
  run: Exec = exec,
  platform: NodeJS.Platform = process.platform,
) {
  const service = serviceFor(platform, home, [], identity());
  for (const command of service.uninstall) await run(command);
  await rm(service.file, { force: true });
  if (platform === "linux") await run(["systemctl", "--user", "daemon-reload"]);
  return { file: service.file };
}

const USAGE = `usage: quench agent install --source <dir> --machine <name> [--project <dir>] [--interval 300]
       quench agent uninstall
       quench agent run --source <dir> --machine <name> [--project <dir>] [--interval 300] [--once]
`;

export async function agent(
  home: Home,
  rest: string[],
  flags: {
    source?: string;
    machine?: string;
    projects: string[];
    interval: number;
    once: boolean;
    homeFlags: string[];
  },
) {
  const [sub] = rest;
  if (!sub || !["install", "uninstall", "run"].includes(sub) || rest.length !== 1) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!Number.isInteger(flags.interval) || flags.interval < 10) {
    process.stderr.write("--interval must be a whole number of seconds, at least 10\n");
    return 1;
  }
  if (flags.once && sub !== "run") {
    process.stderr.write("--once is only available for agent run\n");
    return 1;
  }
  try {
    if (sub === "uninstall") {
      const { file } = await agentUninstall(home);
      process.stdout.write(`removed the Quench agent service (${file})\n`);
      return 0;
    }
    if (!flags.source || !flags.machine) {
      process.stderr.write(`agent ${sub} needs --source <dir> and --machine <name>\n`);
      return 1;
    }
    const options = {
      source: flags.source,
      machine: flags.machine,
      projects: flags.projects,
      interval: flags.interval,
      homeFlags: flags.homeFlags,
    };
    if (sub === "run") return await agentRun(home, { ...options, once: flags.once });
    const { file, warnings } = await agentInstall(home, options);
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stdout.write(
      `installed the Quench agent service (${file}); status: ${statusFile(home)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
