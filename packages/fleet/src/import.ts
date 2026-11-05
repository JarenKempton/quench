import { z } from "zod";
import { own, type HarnessId } from "./common.ts";
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
  folders?: Record<string, string>;
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
    skills[name] = { path: entry.path, ...(entry.scope ? { scope: entry.scope } : {}) };
    byPath.set(entry.path, name);
  }
  const skillOf = (ref: string) => {
    const exact = byPath.get(ref);
    if (exact) return exact;
    const known = own(skills, leaf(ref));
    if (!ref.includes("/")) return known ? leaf(ref) : null;
    if (known) {
      const folder = repo.folders && own(repo.folders, ref);
      if (folder !== undefined && folder === own(repo.folders!, known.path)) return leaf(ref);
      warnings.push(`${ref}: registry has ${leaf(ref)} at ${known.path}, not substituted`);
      return null;
    }
    skills[leaf(ref)] = { path: ref };
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
    machines[machine] = { tags: [], scopes: [] };
    for (const [host, text] of Object.entries(hosts)) {
      const harness = HOSTS[host.split("-")[0] ?? ""];
      if (!harness) {
        warnings.push(`hosts/overrides/${machine}/${host}.manifest: no supported harness, skipped`);
        continue;
      }
      const base = new Set([...global].filter(([, h]) => h.includes(harness)).map(([s]) => s));
      const final = new Set(base);
      for (const line of lines(text)) {
        const sign = line[0];
        const skill = (sign === "+" || sign === "-") && skillOf(line.slice(1).trim());
        if (!skill) {
          warnings.push(`hosts/overrides/${machine}/${host}.manifest: ignored "${line}"`);
          continue;
        }
        if (sign === "+") final.add(skill);
        else final.delete(skill);
      }
      for (const skill of new Set([...base, ...final]))
        if (base.has(skill) !== final.has(skill))
          assignments.push({
            skill,
            target: { kind: "machine", machine },
            scope: { kind: "global" },
            harnesses: [harness],
            mode: final.has(skill) ? "include" : "exclude",
          });
    }
  }

  const sortedSkills = Object.fromEntries(Object.entries(skills).sort(([a], [b]) => cmp(a, b)));
  const sortedMachines = Object.fromEntries(Object.entries(machines).sort(([a], [b]) => cmp(a, b)));
  assignments.sort(byAssignment);
  return {
    fleet: FleetFile.parse({
      version: 1,
      openScopes: [
        ...new Set(Object.values(skills).flatMap((s) => (s.scope ? [s.scope] : []))),
      ].sort(cmp),
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
