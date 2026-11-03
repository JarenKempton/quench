import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { Ecosystem } from "./launch.ts";
import { record } from "./mcp.ts";
import type { HarnessId } from "./model.ts";

export type SkillSource = {
  name: string;
  kind: "marketplace" | "plugin" | "package";
  source: string;
  ecosystem: Ecosystem;
  spec: string;
};

export type SkillSourceEntry = SkillSource & { harness: HarnessId };

export async function skillSourceInventory(home: Home, project: string) {
  const sources: SkillSourceEntry[] = [];
  const warnings: string[] = [];
  for (const harness of harnesses) {
    const found = await harness.skillSources(home, project).catch((error: Error) => {
      warnings.push(`${harness.label}: ${error.message}`);
      return [];
    });
    sources.push(...found.map((source) => ({ ...source, harness: harness.id })));
  }
  return { sources, warnings };
}

export function pluginSourceSpec(value: unknown): Pick<SkillSource, "ecosystem" | "spec"> | null {
  const source = record(value);
  const ref = [source.sha, source.ref].find((part) => typeof part === "string");
  const at = ref ? `#${ref}` : "";
  const url = typeof source.url === "string" ? stripAuth(source.url) : null;
  if (source.source === "github" && typeof source.repo === "string")
    return { ecosystem: "git", spec: `github:${source.repo}${at}` };
  if (["git", "git-subdir", "url"].includes(String(source.source)) && url)
    return { ecosystem: "git", spec: `git+${url}${at}` };
  if (source.source === "npm" && typeof source.package === "string") {
    const version = typeof source.version === "string" ? `@${source.version}` : "";
    return { ecosystem: "npm", spec: `${source.package}${version}` };
  }
  return null;
}

export function piPackageSpec(value: unknown): Pick<SkillSource, "ecosystem" | "spec"> | null {
  const raw = typeof value === "string" ? value : record(value).source;
  if (typeof raw !== "string") return null;
  if (raw.startsWith("npm:")) return { ecosystem: "npm", spec: raw.slice(4) };
  const git = /^(?:git:|https?:\/\/|ssh:\/\/|git@)/.test(raw);
  if (!git) return null;
  const [, base, ref] = /^(.*?\/[^@/]+?)(?:@([^@/]+))?$/.exec(raw.replace(/^git:/, "")) ?? [];
  const url = stripAuth(
    /^\w+:\/\//.test(base!) || base!.startsWith("git@") ? base! : `https://${base}`,
  );
  return { ecosystem: "git", spec: `git+${url}${ref ? `#${ref}` : ""}` };
}

const stripAuth = (url: string) => url.replace(/:\/\/[^/@\s]+@/, "://");
