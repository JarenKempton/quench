import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Home } from "@quench/history";
import { textOf, tracked } from "./secret.ts";

export type Footprint = {
  path: string;
  project: string | null;
  reason: string;
  tracked: boolean | null;
};

const WORKFLOW_MARKERS: [RegExp, string][] = [
  [/toJSON\(\s*secrets\s*\)/i, "dumps every repository secret with toJSON(secrets)"],
  [/webhook\.site/i, "sends data to webhook.site"],
  [/shai-?hulud|SHA1HULUD/i, "carries the Shai-Hulud worm marker"],
  [/s1ngularity/i, "carries the s1ngularity marker"],
];

const INSTALL_MARKERS: [RegExp, string][] = [
  [/\bbundle\.js\b/, "runs bundle.js, the Shai-Hulud payload"],
  [/\bsetup_bun\.js\b|\bbun_environment\.js\b/, "runs the Shai-Hulud 2.0 payload"],
  [/\btelemetry\.js\b/, "runs telemetry.js, the Nx s1ngularity payload"],
];

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

export async function wormFootprints(home: Home, projects: readonly string[]) {
  const found: Footprint[] = [];
  for (const project of projects) {
    found.push(...(await workflows(project)), ...(await installScripts(project)));
  }
  for (const name of ["inventory.txt", "inventory.txt.bak"]) {
    const path = join(tmpdir(), name);
    if ((await textOf(path)) !== null)
      found.push({ path, project: null, reason: "s1ngularity harvest list", tracked: null });
  }
  for (const name of [".bashrc", ".zshrc"]) {
    const path = join(home.dir, name);
    if (/shutdown -h 0/.test((await textOf(path)) ?? ""))
      found.push({ path, project: null, reason: "s1ngularity shutdown line", tracked: null });
  }
  return found;
}

async function workflows(project: string): Promise<Footprint[]> {
  const dir = join(project, ".github/workflows");
  const found: Footprint[] = [];
  for (const name of await names(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const path = join(dir, name);
    const text = (await textOf(path)) ?? "";
    for (const [marker, reason] of WORKFLOW_MARKERS)
      if (marker.test(text))
        found.push({
          path,
          project,
          reason,
          tracked: await tracked(relative(project, path), project),
        });
  }
  return found;
}

async function installScripts(project: string): Promise<Footprint[]> {
  const modules = join(project, "node_modules");
  const packages: string[] = [];
  for (const name of await names(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@"))
      for (const scoped of await names(join(modules, name)))
        packages.push(join(modules, name, scoped));
    else packages.push(join(modules, name));
  }
  const found: Footprint[] = [];
  for (const dir of packages) {
    const path = join(dir, "package.json");
    const manifest = parse(await textOf(path));
    for (const script of INSTALL_SCRIPTS) {
      const command = manifest?.scripts?.[script];
      if (typeof command !== "string") continue;
      for (const [marker, reason] of INSTALL_MARKERS)
        if (marker.test(command))
          found.push({ path, project, reason: `${script} ${reason}`, tracked: null });
    }
  }
  return found;
}

function parse(text: string | null): { scripts?: Record<string, unknown> } | null {
  try {
    return text ? (JSON.parse(text) as { scripts?: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}

const names = (dir: string) => readdir(dir).catch((): string[] => []);
