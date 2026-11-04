import { checkout, sessionPlaces, steeringInventory, type Home } from "@quench/history";
import { placeCache } from "../cache.ts";
import { chars, count, json, plural, shortPath, table } from "../format.ts";
import { reading } from "../progress.ts";
import { autoMemory } from "../profile/recorded-instructions.ts";
import {
  conflictingRules,
  duplicateRules,
  staleRules,
  type RuleAt,
} from "../profile/steering-findings.ts";
import { rankedItems } from "../profile/steering-loads.ts";

const LIMITATIONS = [
  "Ranking multiplies recorded loads: each session in this project whose history logged injecting the file adds the characters it recorded. Codex records one combined block per directory, so its loads are not attributed to files.",
  "Duplicates are rules with identical wording once case, punctuation and list markers are ignored, found in at least two file locations, byte-identical copies included.",
  "Conflicts and stale entries are heuristics. A possible conflict is a global and a project rule with the same wording apart from negation and modal words, one negated and one not. A possibly stale entry names, in backticks, a file that is not on disk now, a command not on PATH, or a package script missing from the nearest package.json of every location the file applies from (abstaining when they differ). Relative files are checked for project files only; flags are not checked.",
];

export async function steering(
  home: Home,
  directories: string[],
  options: { json: boolean; days: number; rules: boolean; cache: boolean },
): Promise<number> {
  if (directories.length !== 1) {
    process.stderr.write("steering requires exactly one explicit project directory\n");
    return 1;
  }
  try {
    const inventory = await steeringInventory(home, directories[0]!);
    const since = new Date(Date.now() - options.days * 86_400_000);
    const cache = options.cache ? await placeCache(home.dir) : undefined;
    const { places } = await sessionPlaces(home, since, reading(), cache);
    const ranked = await rankedItems(inventory.files, places, inventory.project);
    const top = (await checkout(inventory.project))?.top ?? inventory.project;
    const result = {
      ...inventory,
      days: options.days,
      ranked: ranked.items,
      coverage: ranked.coverage,
      duplicates: duplicateRules(inventory.files),
      conflicts: conflictingRules(inventory.files),
      stale: await staleRules(inventory.files, {
        homeDir: home.dir,
        project: inventory.project,
        top,
      }),
      limitations: [...LIMITATIONS, ...inventory.limitations],
    };
    if (options.json) {
      process.stdout.write(json(result));
      return 0;
    }
    const claudeHome = home.of({
      variable: "CLAUDE_CONFIG_DIR",
      fallback: ".claude",
    });
    const label = (path: string) => {
      const memory = autoMemory(path, claudeHome, [top, inventory.project]);
      return memory ? `auto memory · ${memory.file}` : shortPath(path, home.dir);
    };
    const at = (rule: RuleAt) => `${label(rule.path)}:${rule.startLine}-${rule.endLine}`;
    const excerpt = (text: string) => {
      const line = text.replace(/\s+/g, " ").trim();
      return line.length > 72 ? `${line.slice(0, 71)}…` : line;
    };
    const { coverage } = ranked;
    const lines = [
      `Steering · ${inventory.project}`,
      `Instruction items ranked by characters × sessions loaded · ${plural(coverage.sessions, "session")} here in the last ${options.days} days, ${count(coverage.unrecorded)} recorded no instructions, ${count(coverage.combinedOnly)} only combined blocks`,
      ...(result.ranked.length
        ? table(
            [
              ["Item", "Scope", "Size", "Sessions", "Loaded"],
              ...result.ranked.map((item) => [
                label(item.path),
                item.scope,
                chars(item.chars),
                count(item.sessions),
                item.sessions ? chars(item.loadedChars) : "not recorded",
              ]),
            ],
            [2, 3, 4],
          )
        : ["  No instruction files found."]),
    ];
    lines.push("", `Duplicate rules across files (${count(result.duplicates.length)})`);
    for (const group of result.duplicates)
      lines.push(`  "${excerpt(group[0]!.text)}"`, ...group.map((rule) => `    ${at(rule)}`));
    lines.push(
      "",
      `Possible conflicts, global vs project · heuristic (${count(result.conflicts.length)})`,
    );
    for (const { global, project } of result.conflicts)
      lines.push(
        `  global   ${at(global)}  "${excerpt(global.text)}"`,
        `  project  ${at(project)}  "${excerpt(project.text)}"`,
      );
    lines.push("", `Possibly stale · heuristic (${count(result.stale.length)})`);
    for (const rule of result.stale)
      lines.push(
        `  ${at(rule)}  ${rule.missing.map((m) => `${m.kind} \`${m.name}\` not found`).join(", ")}`,
      );
    if (options.rules)
      for (const file of inventory.files) {
        lines.push("", `${label(file.sources[0]!.path)} · ${chars(file.chars)}`);
        for (const rule of file.rules)
          lines.push(
            `  ${file.sources[0]!.realPath}:${rule.startLine}-${rule.endLine}`,
            ...rule.text.split("\n").map((line) => `    ${line}`),
          );
      }
    else lines.push("", "Every bullet and paragraph: quench steering <dir> --rules");
    lines.push("", ...result.limitations);
    for (const warning of inventory.warnings) lines.push(`Warning: ${warning}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
