import { steeringInventory, type Home } from "@quench/history";
import { json } from "../format.ts";

export async function steering(
  home: Home,
  directories: string[],
  options: { json: boolean },
): Promise<number> {
  if (directories.length !== 1) {
    process.stderr.write("steering requires exactly one explicit project directory\n");
    return 1;
  }
  try {
    const inventory = await steeringInventory(home, directories[0]!);
    if (options.json) process.stdout.write(json(inventory));
    else {
      const lines = [
        `Current steering inventory · ${inventory.project}`,
        "Evidence: current disk · historical loading: unknown",
        `${inventory.files.length} unique file contents · ${inventory.files.reduce((n, file) => n + file.rules.length, 0)} bullet/paragraph candidates (not semantic rules)`,
      ];
      for (const file of inventory.files) {
        lines.push("", `${file.id.slice(0, 12)} · ${file.bytes} bytes`);
        for (const source of file.sources)
          lines.push(
            `  ${source.harness} · ${source.scope} · ${source.path}${source.path === source.realPath ? "" : ` → ${source.realPath}`}`,
          );
        const source = file.sources[0]!;
        for (const rule of file.rules)
          lines.push(
            `  ${source.realPath}:${rule.startLine}-${rule.endLine}`,
            ...rule.text.split("\n").map((line) => `    ${line}`),
          );
      }
      lines.push("", ...inventory.limitations);
      for (const warning of inventory.warnings) lines.push(`Warning: ${warning}`);
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
