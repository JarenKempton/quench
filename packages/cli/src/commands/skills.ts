import { harnessById, type Home } from "@quench/history";
import { HARNESSES, plan, targetPath, type HarnessId, type InstalledState } from "@quench/fleet";
import { buildBundle, installedTree, loadFleet } from "@quench/fleet/disk";

export async function userSkillRoot(home: Home, harness: HarnessId): Promise<string> {
  const roots = await harnessById[harness].skills(home, home.dir);
  const root = roots.find((r) => r.scope === "user" && r.layout !== "commands");
  if (!root) throw new Error(`${harness} has no user skill folder`);
  return root.path;
}

const display = (home: Home, path: string) => {
  const slashed = path.replaceAll("\\", "/");
  const prefix = home.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return slashed === prefix
    ? "~"
    : slashed.startsWith(`${prefix}/`)
      ? `~${slashed.slice(prefix.length)}`
      : slashed;
};

const absolute = (home: Home, path: string) =>
  path.startsWith("~/") ? `${home.dir}/${path.slice(2)}` : path;

export async function skillsPlan(home: Home, options: { source: string; machine: string }) {
  const { fleet, warnings } = await loadFleet(options.source);
  const built = await buildBundle(options.source, fleet, options.machine);
  const roots = {} as Record<HarnessId, string>;
  for (const harness of HARNESSES)
    roots[harness] = display(home, await userSkillRoot(home, harness));
  const installed: Record<string, InstalledState | undefined> = {};
  for (const p of built.bundle.placements) {
    if (p.scope.kind !== "global") continue;
    const path = targetPath(roots[p.harness], p.skill);
    installed[path] = await installedTree(absolute(home, path));
  }
  return plan({
    bundle: built.bundle,
    roots,
    installed,
    ledger: [],
    warnings: [...warnings, ...built.warnings],
  });
}

export async function skills(
  home: Home,
  rest: string[],
  options: { source?: string; machine?: string; json: boolean },
) {
  const [sub] = rest;
  if (sub !== "plan" || rest.length !== 1) {
    process.stderr.write("usage: quench skills plan --source <dir> --machine <name> --json\n");
    return 1;
  }
  if (!options.source || !options.machine || !options.json) {
    process.stderr.write("skills plan needs --source <dir>, --machine <name> and --json\n");
    return 1;
  }
  try {
    const result = await skillsPlan(home, { source: options.source, machine: options.machine });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
