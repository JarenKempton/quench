import { z } from "zod";
import type { HarnessId } from "./common.ts";
import { cmp, FleetFile, scopeKey, type Assignment } from "./fleet.ts";

const Registry = z.object({
  skills: z.record(
    z.string(),
    z.object({ path: z.string(), scope: z.string().optional() }).loose(),
  ),
});

export type SkillsRepo = {
  registry: string;
  manifests: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
};

const HOSTS: Record<string, HarnessId> = { claude: "claude-code", codex: "codex", pi: "pi" };

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

const leaf = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

export function importSkillsRepo(repo: SkillsRepo): { fleet: FleetFile; warnings: string[] } {
  const warnings: string[] = [];
  const registry = Registry.parse(Bun.YAML.parse(repo.registry));
  const skills: FleetFile["skills"] = {};
  const byPath = new Map<string, string>();
  for (const [name, entry] of Object.entries(registry.skills)) {
    skills[name] = { path: entry.path, labels: entry.scope ? [entry.scope] : [] };
    byPath.set(entry.path, name);
  }
  const skillOf = (ref: string) => {
    const name = byPath.get(ref) ?? (skills[leaf(ref)] ? leaf(ref) : null);
    if (name) return name;
    if (!ref.includes("/")) return null;
    skills[leaf(ref)] = { path: ref, labels: [] };
    byPath.set(ref, leaf(ref));
    warnings.push(`${ref}: not in registry.yaml, imported as ${leaf(ref)}`);
    return leaf(ref);
  };
  const harnessOf = (host: string) => {
    const harness = HOSTS[host.split("-")[0] ?? ""];
    if (!harness) warnings.push(`hosts/${host}.manifest: no supported harness, skipped`);
    else if (!host.endsWith("-global")) warnings.push(`hosts/${host}.manifest: imported as global`);
    return harness;
  };

  const assignments: Assignment[] = [];
  const global = new Map<string, HarnessId[]>();
  for (const [host, text] of Object.entries(repo.manifests)) {
    const harness = harnessOf(host);
    if (!harness) continue;
    for (const ref of lines(text)) {
      const skill = skillOf(ref);
      if (skill) global.set(skill, [...(global.get(skill) ?? []), harness]);
    }
  }
  for (const [skill, harnesses] of global)
    assignments.push({
      skill,
      target: { kind: "all" },
      scope: { kind: "global" },
      harnesses: [...new Set(harnesses)].sort(),
      mode: "include",
    });

  const machines: FleetFile["machines"] = {};
  for (const [machine, hosts] of Object.entries(repo.overrides)) {
    machines[machine] = { tags: [] };
    for (const [host, text] of Object.entries(hosts)) {
      const harness = HOSTS[host.split("-")[0] ?? ""];
      if (!harness) {
        warnings.push(`hosts/overrides/${machine}/${host}.manifest: no supported harness, skipped`);
        continue;
      }
      for (const line of lines(text)) {
        const mode = line[0] === "+" ? "include" : line[0] === "-" ? "exclude" : null;
        const skill = mode && skillOf(line.slice(1).trim());
        if (!mode || !skill) {
          warnings.push(`hosts/overrides/${machine}/${host}.manifest: ignored "${line}"`);
          continue;
        }
        assignments.push({
          skill,
          target: { kind: "machine", machine },
          scope: { kind: "global" },
          harnesses: [harness],
          mode,
        });
      }
    }
  }

  const sortedSkills = Object.fromEntries(Object.entries(skills).sort(([a], [b]) => cmp(a, b)));
  const sortedMachines = Object.fromEntries(Object.entries(machines).sort(([a], [b]) => cmp(a, b)));
  assignments.sort(byAssignment);
  return {
    fleet: FleetFile.parse({
      version: 1,
      skills: sortedSkills,
      machines: sortedMachines,
      assignments,
    }),
    warnings: warnings.sort(cmp),
  };
}

const targetKey = (a: Assignment) => {
  const t = a.target;
  return `${t.kind}:${t.kind === "all" ? "" : t.kind === "tag" ? t.tag : t.kind === "person" ? t.person : t.machine}`;
};

const byAssignment = (a: Assignment, b: Assignment) =>
  cmp(a.skill, b.skill) ||
  cmp(targetKey(a), targetKey(b)) ||
  cmp(scopeKey(a.scope), scopeKey(b.scope)) ||
  cmp(String(a.harnesses), String(b.harnesses)) ||
  cmp(a.mode, b.mode);
