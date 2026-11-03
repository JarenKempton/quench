import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathParts, type Home } from "@quench/history";
import type { Masker } from "./mask.ts";
import { findingId, textOf, tracked } from "./secret.ts";

export type Footprint = {
  id: string;
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

const KNOWN_INSTALL = new Set([
  "esbuild postinstall 912d4d8f507b7b392ae422a459f98da94669a742e4cc43cfe061e630ee2846fe",
]);

const installHash = (command: string) => createHash("sha256").update(command).digest("hex");

const knownInstall = (name: unknown, script: string, command: string) =>
  KNOWN_INSTALL.has(`${String(name)} ${script} ${installHash(command)}`);

type Found = Omit<Footprint, "id">;

export async function wormFootprints(
  home: Home,
  projects: readonly string[],
  mask: Masker,
  days: number,
) {
  const since = Date.now() - days * 86_400_000;
  const found: Found[] = [];
  for (const project of projects) {
    found.push(
      ...(await workflows(project)),
      ...(await installScripts(project, { mask, since, days })),
    );
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
  return found.map((f): Footprint => ({ id: findingId(mask, f.path, f.reason), ...f }));
}

async function workflows(project: string): Promise<Found[]> {
  const dir = join(project, ".github/workflows");
  const found: Found[] = [];
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

async function installScripts(
  project: string,
  recent: { mask: Masker; since: number; days: number },
): Promise<Found[]> {
  const modules = join(project, "node_modules");
  const packages: string[] = [];
  for (const name of await names(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@"))
      for (const scoped of await names(join(modules, name)))
        packages.push(join(modules, name, scoped));
    else packages.push(join(modules, name));
  }
  const found: Found[] = [];
  for (const dir of packages) {
    if (!pathParts(await realpath(dir).catch(() => dir)).includes("node_modules")) continue;
    const path = join(dir, "package.json");
    const manifest = parse(await textOf(path));
    const written = (await stat(path).catch(() => null))?.ctimeMs ?? 0;
    for (const script of INSTALL_SCRIPTS) {
      const command = manifest?.scripts?.[script];
      if (typeof command !== "string") continue;
      const payload = INSTALL_MARKERS.find(([marker]) => marker.test(command));
      if (payload) found.push({ path, project, reason: `${script} ${payload[1]}`, tracked: null });
      else if (written >= recent.since && !knownInstall(manifest?.name, script, command))
        found.push({
          path,
          project,
          reason: `${script} added in the last ${recent.days} days: ${recent.mask.scrubbed(command, 60)}`,
          tracked: null,
        });
    }
  }
  return found;
}

type Manifest = { name?: unknown; scripts?: Record<string, unknown> };

function parse(text: string | null): Manifest | null {
  try {
    return text ? (JSON.parse(text) as Manifest) : null;
  } catch {
    return null;
  }
}

const names = (dir: string) => readdir(dir).catch((): string[] => []);
