import { join } from "node:path";
import type { Home } from "@quench/history";
import {
  secretsReport,
  type CredentialFile,
  type FileSecrets,
  type SecretsReport,
} from "@quench/secrets";
import { count, json, plural, shortPath, table } from "../format.ts";
import { reading } from "../progress.ts";

export async function secrets(
  home: Home,
  options: { json: boolean; hostHistory?: string | false },
): Promise<number> {
  const report = await secretsReport(home, {
    hostHistory: options.hostHistory ?? join(home.dir, ".t3/userdata/statev2.sqlite"),
    onRead: reading(),
  });
  process.stdout.write(options.json ? json(report) : render(report, home.dir).join("\n") + "\n");
  return 0;
}

function render(report: SecretsReport, homeDir: string): string[] {
  const short = (path: string) => shortPath(path, homeDir);
  const day = (iso: string | null) => iso?.slice(0, 10) ?? "unknown";
  const { history } = report;
  const lines = [
    "Quench secrets · local only, nothing is sent anywhere · values show their first 4 characters and a hash",
    "",
    `Session history · ${plural(history.secrets.length, "secret")} in ${count(history.sessions)} sessions${history.hostMessages ? ` and ${count(history.hostMessages)} T3 messages` : ""}`,
  ];
  if (history.secrets.length)
    lines.push(
      ...table([
        ["Provider", "Value", "Sessions", "First seen", "Last seen", "Exposed by"],
        ...history.secrets.map((s) => [
          s.provider,
          s.masked,
          count(s.sessions),
          day(s.firstSeen),
          day(s.lastSeen),
          s.exposures[0]?.by ?? "",
        ]),
      ]),
    );
  lines.push(
    "",
    `Harness and MCP configs · ${plural(report.configs.length, "file")} with plaintext secrets`,
  );
  lines.push(...files(report.configs, short));
  lines.push("", `Risky permissions · ${count(report.permissions.length)}`);
  if (report.permissions.length)
    lines.push(
      ...table(report.permissions.map((p) => [p.harness, p.kind, p.setting, short(p.source)])),
    );
  lines.push(
    "",
    `Skills and instruction files · ${plural(report.instructions.files.length, "file")} with secrets of ${count(report.instructions.scanned)} scanned`,
  );
  lines.push(...files(report.instructions.files, short));
  lines.push("", "Credential files worms harvest");
  lines.push(...credentialTable(report.credentialFiles, short));
  lines.push(
    "",
    `Worm footprints in ${plural(report.projects, "known project")} · ${count(report.footprints.length)}`,
  );
  for (const f of report.footprints)
    lines.push(
      `  ${short(f.path)} · ${f.reason}${f.tracked === false ? " · not tracked by git" : ""}`,
    );
  const rotate = new Map(
    [
      ...history.secrets,
      ...report.configs.flatMap((f) => f.secrets),
      ...report.instructions.files.flatMap((f) => f.secrets),
    ]
      .filter((s) => s.rotate)
      .map((s) => [s.provider, s.rotate!]),
  );
  if (rotate.size) {
    lines.push("", "Where to rotate");
    lines.push(...table([...rotate].sort(([a], [b]) => a.localeCompare(b))));
  }
  lines.push("", ...report.limitations);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines;
}

function files(found: FileSecrets[], short: (path: string) => string): string[] {
  return found.map((file) => {
    const providers = [...new Set(file.secrets.map((s) => s.provider))].join(", ");
    const values = file.secrets.map((s) => s.masked).join(" ");
    const flag = file.tracked ? " · tracked by git" : "";
    return `  ${short(file.path)} · ${plural(file.secrets.length, "secret")} (${providers}) ${values}${flag}`;
  });
}

function credentialTable(found: CredentialFile[], short: (path: string) => string): string[] {
  const yes = (value: boolean | null) => (value === null ? "unknown" : value ? "yes" : "no");
  const present = found.filter((f) => f.present);
  const absent = found.filter((f) => !f.present).map((f) => short(f.path));
  const lines = present.length
    ? table([
        ["File", "What", "Plaintext", "Mode", "Agent read", "Agent printed"],
        ...present.map((f) => [
          short(f.path),
          f.label,
          yes(f.plaintext),
          f.mode ? `${f.mode}${f.othersCanRead ? " others can read" : ""}` : "",
          f.readInSessions ? plural(f.readInSessions, "session") : "no",
          f.printedInSessions ? "yes" : "no",
        ]),
      ])
    : [];
  if (absent.length) lines.push(`  Absent: ${absent.join(", ")}`);
  return lines;
}
