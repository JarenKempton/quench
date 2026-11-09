import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Home } from "@quench/history";
import { clientDir, loadConnection } from "@quench/hub/client";
import { agentCycle, applyAndReport, statusFile } from "./agent-cycle.ts";
import { hubCycle, hubLine } from "./agent-hub.ts";
import { DEFAULT_OTLP, otelSettings, otlpLine, otlpListen, startOtlp } from "./agent-otlp.ts";
import { stateDir } from "./skills.ts";

export type AgentOptions = {
  source?: string;
  machine?: string;
  projects?: string[];
  interval: number;
  homeFlags: string[];
  otlp?: string;
};

const summary = (status: Awaited<ReturnType<typeof applyAndReport>>) =>
  status.error
    ? `error: ${status.error}`
    : `applied ${status.applied.length}, conflicts ${status.conflicts.length}`;

export async function agentRun(home: Home, options: AgentOptions & { once: boolean }) {
  const otlp =
    options.otlp && !options.source ? await startOtlp(clientDir(home.dir), options.otlp) : null;
  try {
    return await cycles(home, options, otlp);
  } finally {
    await otlp?.stop();
  }
}

async function cycles(
  home: Home,
  options: AgentOptions & { once: boolean },
  otlp: Awaited<ReturnType<typeof startOtlp>> | null,
) {
  for (;;) {
    let line: string;
    let failed: boolean;
    if (options.source && options.machine) {
      const status = await agentCycle(home, {
        ...options,
        source: options.source,
        machine: options.machine,
      });
      line = `${status.snapshot.takenAt} ${summary(status)}`;
      failed = !!status.error || status.conflicts.length > 0;
    } else {
      const status = await hubCycle(home, options);
      await otlp?.flush();
      line = `${status.snapshot.takenAt} ${summary(status)}${hubLine(status)}${otlp ? otlpLine(otlp.stats) : ""}`;
      failed = !!status.error || !!status.hub.error || status.conflicts.length > 0;
    }
    process.stdout.write(`${line}\n`);
    if (options.once) return failed ? 1 : 0;
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
    ...(options.source ? ["--source", resolve(options.source)] : []),
    ...(options.machine ? ["--machine", options.machine] : []),
    ...(options.projects ?? []).flatMap((p) => ["--project", resolve(p)]),
    ...(options.otlp ? ["--otlp", options.otlp] : []),
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

const USAGE = `usage: quench agent install [--source <dir> --machine <name>] [--project <dir>] [--interval 300] [--otlp <host:port>]
       quench agent uninstall
       quench agent run [--source <dir> --machine <name>] [--project <dir>] [--interval 300] [--once] [--otlp <host:port>]
       quench agent otel [--otlp <host:port>]
       Without --source, the agent follows the hub this machine is paired with (quench connect),
       and ships its session transcripts and per-session results to the hub's archive.
       --otlp also listens for OTLP/HTTP JSON on that loopback address, strips it, and forwards it.
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
    otlp?: string;
  },
) {
  const [sub] = rest;
  if (!sub || !["install", "uninstall", "run", "otel"].includes(sub) || rest.length !== 1) {
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
    if (flags.otlp !== undefined) otlpListen(flags.otlp);
    if (sub === "otel") {
      process.stdout.write(otelSettings(flags.otlp ?? DEFAULT_OTLP));
      return 0;
    }
    if (flags.otlp !== undefined && flags.source) {
      process.stderr.write("--otlp forwards to the paired hub; it cannot be used with --source\n");
      return 1;
    }
    if (sub === "uninstall") {
      const { file } = await agentUninstall(home);
      process.stdout.write(`removed the Quench agent service (${file})\n`);
      return 0;
    }
    if (!flags.source !== !flags.machine) {
      process.stderr.write(
        `agent ${sub} needs both --source <dir> and --machine <name>, or neither to follow the hub this machine is paired with\n`,
      );
      return 1;
    }
    if (!flags.source)
      await loadConnection(clientDir(home.dir)).catch(() => {
        throw new Error(
          "this machine is not paired with a hub; run quench connect first, or pass --source and --machine",
        );
      });
    const options = {
      ...(flags.source ? { source: flags.source } : {}),
      ...(flags.machine ? { machine: flags.machine } : {}),
      projects: flags.projects,
      interval: flags.interval,
      homeFlags: flags.homeFlags,
      ...(flags.otlp ? { otlp: flags.otlp } : {}),
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
