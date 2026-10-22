import { realpath } from "node:fs/promises";
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
    const ref = (await discoverAll(home)).find((ref) => ref.path === path);
    if (!ref) throw new Error(`${path} is not a session any known harness discovered`);
    const report = sourceTrace(await harnessById[ref.harness].read(ref));
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
          lines.push(
            `  ${r.path} · ${r.lineCount ? `reported lines ${r.startLine}–${r.startLine + r.lineCount - 1} of ${r.totalLines}` : "0 reported lines"}`,
          );
          lines.push(
            `  recorded tool text: ${r.returnedTextChars} characters · sha256 ${r.returnedTextSha256}`,
          );
        }
        if (read.reason) lines.push(`  ${read.reason}`);
      }
      lines.push("", ...report.limitations, ...report.warnings.map((w) => `Warning: ${w}`));
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
