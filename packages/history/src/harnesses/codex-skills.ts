import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isInside, pathParts } from "../files.ts";
import type { HarnessHome } from "../harness.ts";
import { readJson } from "../mcp.ts";
import { quoteArg, withEnv } from "../removal.ts";
import {
  folderCut,
  folderOrigin,
  notFound,
  type CutContext,
  type OriginOf,
  type SkillCut,
  type SkillOrigin,
} from "../skill-origin.ts";

const Catalog = z.looseObject({
  /** Remote plugins the account can see, as last fetched by Codex. */
  plugins: z.array(
    z.looseObject({
      /** Remote plugin id, as in `.codex-remote-plugin-install.json`. */
      id: z.string(),
      /** `AVAILABLE`, or `INSTALLED_BY_DEFAULT` for plugins Codex will not uninstall. */
      installation_policy: z.string().nullish(),
    }),
  ),
});

const InstallMarker = z.looseObject({
  /** Remote plugin id this cached plugin was installed from. */
  remote_plugin_id: z.string(),
});

export async function codexSkillOrigins(codexHome: string): Promise<OriginOf> {
  const cache = join(codexHome, "plugins/cache");
  const { remote, local } = await installedPlugins(cache);
  const byDefault = await installedByDefault(codexHome, remote);
  const fromRemote = new Set(remote.values());
  const system = join(codexHome, "skills/.system");
  return (skill, onDisk) => {
    const path = skill.path;
    if (path && isInside(path, system)) return { kind: "built-in" };
    if (path && isInside(path, cache)) {
      const [marketplace, name] = pathParts(path.slice(cache.length));
      const plugin = `${name}@${marketplace}`;
      if (!fromRemote.has(plugin) && !local.has(plugin)) return notFound(skill, plugin);
      const installedByDefault = byDefault.has(plugin) || (fromRemote.has(plugin) ? null : false);
      return { kind: "plugin", plugin, installedByDefault };
    }
    return folderOrigin("codex", skill, onDisk) ?? notFound(skill);
  };
}

export function codexSkillCut(
  origin: SkillOrigin,
  { home, shell }: CutContext,
  harnessHome: HarnessHome,
): SkillCut {
  if (origin.kind === "built-in") return { command: null, note: "built into Codex" };
  if (origin.kind !== "plugin") return folderCut(origin)!;
  if (origin.installedByDefault)
    return {
      command: null,
      note: "installed by default; Codex refuses to uninstall it. Turn it off in codex → /plugins",
    };
  return {
    command: withEnv(
      harnessHome.variable,
      home.override(harnessHome),
      `codex plugin remove ${quoteArg(origin.plugin, shell)}`,
      shell,
    ),
    note:
      origin.installedByDefault === null
        ? "if Codex refuses with 403 (installed by default), turn it off in codex → /plugins"
        : null,
  };
}

async function installedPlugins(cache: string) {
  const remote = new Map<string, string>();
  const local = new Set<string>();
  for (const marketplace of await names(cache))
    for (const plugin of await names(join(cache, marketplace))) {
      const id = `${plugin}@${marketplace}`;
      const marker = InstallMarker.safeParse(
        await readJson(join(cache, marketplace, plugin, ".codex-remote-plugin-install.json")).catch(
          () => null,
        ),
      );
      if (marker.success) remote.set(marker.data.remote_plugin_id, id);
      else local.add(id);
    }
  return { remote, local };
}

async function installedByDefault(
  codexHome: string,
  remote: Map<string, string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (!remote.size) return found;
  const catalogs = join(codexHome, "cache/remote_plugin_catalog");
  for (const file of await names(catalogs)) {
    const catalog = Catalog.safeParse(await readJson(join(catalogs, file)).catch(() => null));
    for (const entry of catalog.success ? catalog.data.plugins : [])
      if (entry.installation_policy === "INSTALLED_BY_DEFAULT" && remote.has(entry.id))
        found.add(remote.get(entry.id)!);
  }
  return found;
}

const names = (dir: string) => readdir(dir).catch(() => [] as string[]);
