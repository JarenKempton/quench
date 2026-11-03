import { realpath } from "node:fs/promises";
import { repositoryRoot, type Home, type Progress } from "@quench/history";
import { scanConfigs } from "./configs.ts";
import { wormFootprints } from "./footprints.ts";
import { credentialFiles } from "./harvest.ts";
import { scanHistory } from "./history.ts";
import { scanInstructions } from "./instructions.ts";

export { detect, detectInFile, entropy, type Detection } from "./detect.ts";
export { fingerprint, masked, scrubbed } from "./mask.ts";
export { sshKeyEncrypted, type CredentialFile } from "./harvest.ts";
export type { FileSecrets } from "./configs.ts";
export type { Footprint } from "./footprints.ts";
export type { Exposure, HistorySecret } from "./history.ts";
export type { Secret } from "./secret.ts";

export async function secretsReport(
  home: Home,
  options: { hostHistory: string | false; onRead?: Progress },
) {
  const history = await scanHistory(home, options);
  const projects = await repositories(history.cwds);
  const configs = await scanConfigs(home, projects);
  const instructions = await scanInstructions(home, projects);
  const printed = new Set(history.secrets.map((secret) => secret.fingerprint));
  const files = await credentialFiles(home, projects, configs.credentials, {
    reads: history.reads,
    printed,
  });
  const footprints = await wormFootprints(home, projects);
  return {
    observedAt: new Date().toISOString(),
    projects: projects.length,
    history: {
      sessions: history.sessions,
      unreadable: history.unreadable,
      hostMessages: history.hostMessages,
      secrets: history.secrets,
    },
    configs: configs.files,
    permissions: configs.permissions,
    instructions: { scanned: instructions.scanned, files: instructions.files },
    credentialFiles: files,
    footprints,
    warnings: [...configs.warnings, ...instructions.warnings],
    limitations: [
      "Everything runs on this machine. No secret, excerpt or finding is sent to Jev, a model or the network.",
      "Values are shown as their first 4 characters and a hash, never in full.",
      "Detection uses the gitleaks ruleset plus an entropy check, so unusual formats can be missed and test values can be reported.",
      "Known projects are the git repositories your sessions ran in; .env files and worm footprints are checked at their top level only.",
      "Agent read means a session recorded reading that exact path; printed means a value from the file appears in session history.",
      "Nothing is changed or redacted.",
    ],
  };
}

export type SecretsReport = Awaited<ReturnType<typeof secretsReport>>;

async function repositories(cwds: Iterable<string>): Promise<string[]> {
  const roots = new Set<string>();
  for (const cwd of cwds) {
    const real = await realpath(cwd).catch(() => null);
    const root = real && (await repositoryRoot(real));
    if (root) roots.add(root);
  }
  return [...roots].sort();
}
