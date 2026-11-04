import { join } from "node:path";
import type { Home } from "@quench/history";
import {
  printable,
  secretsReport,
  type CredentialFile,
  type FileSecrets,
  type GitHook,
  type HistorySecret,
  type Location,
  type Secret,
  type RepoSecret,
  type SecretsReport,
  type UnpinnedSource,
} from "@quench/secrets";
import { count, json, plural, shortPath, table } from "../format.ts";
import { reading } from "../progress.ts";

export async function secrets(
  home: Home,
  options: { json: boolean; days: number; repoHistory?: boolean; hostHistory?: string | false },
): Promise<number> {
  const report = await secretsReport(home, {
    days: options.days,
    hostHistory: options.hostHistory ?? join(home.dir, ".t3/userdata/statev2.sqlite"),
    repoHistory: options.repoHistory ?? false,
    onRead: reading(),
    onRepo: reading("repositories"),
  });
  process.stdout.write(options.json ? json(report) : render(report, home.dir).join("\n") + "\n");
  return 0;
}

function render(report: SecretsReport, homeDir: string): string[] {
  const short = (path: string) => shortPath(path, homeDir);
  const day = (iso: string | null) => iso?.slice(0, 10) ?? "unknown";
  const { history } = report;
  const lines = [
    "Quench secrets · local only, nothing is sent anywhere · values show their first 4 characters and a keyed tag",
    "",
    `Session history · ${plural(history.secrets.length, "secret")} in ${count(history.sessions)} sessions${history.hostMessages ? ` and ${count(history.hostMessages)} T3 messages` : ""}`,
  ];
  lines.push(...exposed(history.secrets, day));
  lines.push(
    "",
    `Lower confidence (generic rule or secret-named value) · ${plural(history.lowConfidence.length, "value")}`,
  );
  lines.push(...exposed(history.lowConfidence, day));
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
  lines.push(...spread(report.locations, short));
  lines.push("", `Unpinned MCP servers and skills · ${count(report.unpinned.length)}`);
  lines.push(...unpinnedTable(report.unpinned, short));
  const unknown = report.hooks.filter((h) => !h.manager).length;
  lines.push(
    "",
    `Git hooks in known projects · ${count(report.hooks.length)}${unknown ? ` · ${count(unknown)} not from a known hook manager` : ""}`,
  );
  lines.push(...hookTable(report.hooks, short));
  const repo = report.repoHistory;
  lines.push("");
  if (!repo) lines.push("Repo git history · not scanned, pass --repo-history");
  else {
    lines.push(
      `Repo git history · ${plural(repo.secrets.length, "secret")} in ${count(repo.blobs)} file versions from ${count(repo.commits)} commits across ${plural(repo.repos, "repository", "repositories")}${repo.failed ? ` · ${count(repo.failed)} unreadable` : ""} · skipped ${count(repo.skipped.binary)} binary and ${count(repo.skipped.oversize)} over 10 MB`,
    );
    lines.push(...committed(repo.secrets, short));
    lines.push(`Lower confidence in repo history · ${plural(repo.lowConfidence.length, "value")}`);
    lines.push(...committed(repo.lowConfidence, short));
  }
  lines.push(
    ...rotation([
      ...history.secrets,
      ...(repo?.secrets ?? []),
      ...report.configs.flatMap((f) => f.secrets),
      ...report.instructions.files.flatMap((f) => f.secrets),
      ...report.credentialFiles.flatMap((f) => f.values),
    ]),
  );
  lines.push("", ...report.limitations);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines;
}

function rotation(found: Secret[]): string[] {
  const rows = new Map<string, string[]>();
  for (const s of found.filter((s) => s.confidence === "high"))
    rows.set(`${s.provider}\n${s.issuer ?? ""}`, [
      s.provider,
      printable(s.issuer ?? "") ?? "",
      s.rotate ?? "no rotate link known, rotate it where it was issued",
    ]);
  if (!rows.size) return [];
  const sorted = [...rows.values()].sort((a, b) => a.join().localeCompare(b.join()));
  return ["", "Where to rotate", ...table([["Provider", "Issued by", "Rotate at"], ...sorted])];
}

function spread(found: Location[], short: (path: string) => string): string[] {
  const shared = found.filter(
    (l) => l.files.length + l.envVars.length + (l.sessions.length ? 1 : 0) > 1,
  );
  if (!shared.length) return [];
  return [
    "",
    `Values found in more than one place · ${count(shared.length)}`,
    ...table([
      ["Provider", "Value", "Files", "Env vars", "Sessions"],
      ...shared.map((l) => [
        l.provider,
        l.masked,
        l.files.map(short).join(", "),
        l.envVars.join(", "),
        count(l.sessions.length),
      ]),
    ]),
  ];
}

function exposed(found: HistorySecret[], day: (iso: string | null) => string): string[] {
  if (!found.length) return [];
  return table([
    ["Provider", "Value", "Sessions", "First seen", "Last seen", "Exposed by"],
    ...found.map((s) => [
      s.provider,
      s.masked,
      count(s.sessions),
      day(s.firstSeen),
      day(s.lastSeen),
      s.exposures[0]?.by ?? "",
    ]),
  ]);
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
          f.tracked ? `${f.label}, tracked by git` : f.label,
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

function unpinnedTable(found: UnpinnedSource[], short: (path: string) => string): string[] {
  const lines: string[] = [];
  for (const harness of new Set(found.map((s) => s.harness))) {
    lines.push(`  ${harness}`);
    lines.push(
      ...table(
        found
          .filter((s) => s.harness === harness)
          .map((s) => [s.kind, s.name, s.spec, s.reason, `pin to ${s.pinTo}`, short(s.source)]),
      ),
    );
  }
  return lines;
}

function hookTable(found: GitHook[], short: (path: string) => string): string[] {
  if (!found.length) return [];
  return table([
    ["Project", "Hook", "Installed by", "Path"],
    ...found.map((h) => [short(h.project), h.hook, h.manager ?? "unknown", short(h.path)]),
  ]);
}

function committed(found: RepoSecret[], short: (path: string) => string): string[] {
  if (!found.length) return [];
  return table([
    ["Provider", "Value", "File versions", "Introduced", "Repository", "Files"],
    ...found.map((s) => [
      s.provider,
      s.masked,
      count(s.versions),
      s.introducedIn ? `${s.introducedIn} ${s.introducedAt?.slice(0, 10) ?? ""}` : "unknown",
      s.repos.map(short).join(", "),
      s.files.length > 3
        ? `${s.files.slice(0, 3).join(", ")} +${s.files.length - 3}`
        : s.files.join(", "),
    ]),
  ]);
}
