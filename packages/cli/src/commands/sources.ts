import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverAll, harnessById, sourceTrace, type Home } from "@quench/history";
import { json } from "../format.ts";

export async function sources(
  home: Home,
  files: string[],
  options: { json: boolean },
): Promise<number> {
  if (files.length !== 1) {
    process.stderr.write("sources requires exactly one session file\n");
    return 1;
  }
  try {
    const path = await realpath(files[0]!);
    const refs = await discoverAll(home);
    let ref = refs.find((ref) => ref.path === path || ref.path === resolve(files[0]!));
    if (!ref) {
      for (const candidate of refs) {
        if ((await realpath(candidate.path).catch(() => null)) === path) {
          ref = candidate;
          break;
        }
      }
    }
    if (!ref) throw new Error(`${path} is not a session any known harness discovered`);
    const report = sourceTrace(await harnessById[ref.harness].read(ref), home.dir);
    if (options.json) process.stdout.write(json(report));
    else {
      const lines = [
        `Recorded file reads · ${report.session.harness}:${report.session.id}`,
        `Evidence: session history · ${report.session.path}`,
        `Native file-read tracing: ${report.coverage.nativeFileReads} · ${report.reads.length} attempts · ${report.coverage.otherToolCalls} other tool calls without source attribution`,
      ];
      for (const read of report.reads) {
        lines.push(
          "",
          `${read.status} · ${read.requested.path} · call ${read.callId ?? "unknown"}`,
        );
        if (read.returned) {
          const r = read.returned;
          const range =
            r.lineCount === null || r.startLine === null
              ? "line range unknown"
              : r.lineCount === 0
                ? "0 reported lines"
                : `reported lines ${r.startLine}–${r.startLine + r.lineCount - 1} of ${r.totalLines ?? "unknown"}`;
          lines.push(`  ${r.path ?? "result path unknown"} · ${range}`);
          lines.push(
            `  recorded tool text: ${r.returnedTextChars} characters · sha256 ${r.returnedTextSha256}`,
          );
        }
        if (read.reason) lines.push(`  ${read.reason}`);
      }
      lines.push(
        "",
        `Shell reads: ${report.shell.filter((r) => r.kind === "read").length} reads and ${report.shell.filter((r) => r.kind === "search").length} searches and ${report.shell.filter((r) => r.kind.startsWith("script")).length} script file accesses from ${report.coverage.shellCommands} recorded commands`,
      );
      for (const read of report.shell)
        lines.push(
          `  ${read.status} · ${read.kind === "search" ? `${read.program} search ${JSON.stringify(read.pattern ?? "")}` : read.kind.startsWith("script-") ? `${read.program} script ${read.kind.slice(7)}` : read.program} · ${read.path ?? `${read.written} (path not resolved)`}${read.base && read.base !== "absolute" ? ` · relative to ${read.base}` : ""} · call ${read.callId ?? "unknown"}${read.reason ? ` · ${read.reason}` : ""}`,
        );
      lines.push(
        "",
        `MCP calls: ${report.mcp.length} to ${new Set(report.mcp.map((c) => c.server)).size} servers`,
      );
      for (const call of report.mcp)
        lines.push(
          `  ${call.status} · ${call.server} · ${call.tool}${call.outputChars === null ? "" : ` · ${call.outputChars} characters`} · call ${call.callId ?? "unknown"}${call.reason ? ` · ${call.reason}` : ""}`,
        );
      const listed = new Map<string, string | null>();
      for (const listing of report.skills.listings)
        for (const skill of listing.listed)
          if (!listed.has(skill.name) || (listed.get(skill.name) === null && skill.path !== null))
            listed.set(skill.name, skill.path);
      lines.push(
        "",
        `Skill loading: ${report.skills.listings.length} ${report.skills.listings.length === 1 ? "listing" : "listings"} · ${listed.size} listed · ${report.skills.loads.length} ${report.skills.loads.length === 1 ? "load" : "loads"}`,
      );
      for (const [name, skillPath] of listed)
        lines.push(`  listed · ${name} · ${skillPath ?? "path not recorded"}`);
      for (const load of report.skills.loads)
        lines.push(
          load.how === "invoked"
            ? `  invoked · ${load.name} · by ${load.by ?? "unknown"} · ${load.path ?? "path not recorded"}`
            : `  ${load.how} · ${load.name} · ${load.path ?? "path not recorded"} · ${load.status ?? "unknown"}${load.chars === null ? "" : ` · ${load.chars} characters`} · call ${load.callId ?? "unknown"}`,
        );
      lines.push(
        "",
        `Injected instructions: ${report.coverage.injectedInstructions} · ${report.instructions.length} recorded`,
      );
      for (const file of report.instructions)
        lines.push(
          `  ${file.at?.toISOString() ?? "time unknown"} · ${file.path ?? (file.directory ? `combined block for ${file.directory}` : "combined block, directory unknown")} · ${file.label ?? "type unknown"}${file.textDiffersFromFile ? " · injected text differs from the file (processed by the harness)" : ""}`,
          `    recorded text: ${file.textChars} characters · sha256 ${file.textSha256}`,
        );
      lines.push("", ...report.limitations, ...report.warnings.map((w) => `Warning: ${w}`));
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
