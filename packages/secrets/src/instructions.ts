import { skillInventory, steeringInventory, type Home } from "@quench/history";
import type { FileSecrets } from "./configs.ts";
import { detect } from "./detect.ts";
import { secretOf, textOf } from "./secret.ts";

export async function scanInstructions(home: Home, projects: readonly string[]) {
  const candidates = new Map<string, "skill" | "instructions">();
  const warnings: string[] = [];
  for (const project of [home.dir, ...projects]) {
    const skills = await skillInventory(home, project);
    for (const skill of skills.skills) candidates.set(skill.realPath, "skill");
    const steering = await steeringInventory(home, project).catch((error: Error) => {
      warnings.push(error.message);
      return null;
    });
    for (const file of steering?.files ?? [])
      for (const source of file.sources) candidates.set(source.realPath, "instructions");
  }
  const files: FileSecrets[] = [];
  for (const [path, kind] of candidates) {
    const text = await textOf(path);
    const secrets = text ? detect(text).map(secretOf) : [];
    if (secrets.length)
      files.push({ path, harness: null, kind, scope: null, tracked: null, secrets });
  }
  return { files, scanned: candidates.size, warnings };
}
