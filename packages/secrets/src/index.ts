import { realpath } from "node:fs/promises";
import { repositoryRoot, type Home, type Progress } from "@quench/history";
import { scanConfigs } from "./configs.ts";
import { wormFootprints } from "./footprints.ts";
import { credentialFiles } from "./harvest.ts";
import { gitHooks } from "./hooks.ts";
import { scanHistory } from "./history.ts";
import { scanInstructions } from "./instructions.ts";
import { locations } from "./locations.ts";
import { machineKey, masker } from "./mask.ts";
import { scanRepoHistory } from "./repo-history.ts";
import { unpinnedSources } from "./unpinned.ts";

export { detect, detectInFile, entropy, type Detection } from "./detect.ts";
export { printable } from "./issuer.ts";
export { machineKey, masker, type Masker } from "./mask.ts";
export { sshKeyEncrypted, toolConfigFiles, type CredentialFile } from "./harvest.ts";
export type { FileSecrets } from "./configs.ts";
export type { Footprint } from "./footprints.ts";
export type { GitHook } from "./hooks.ts";
export type { RepoSecret } from "./repo-history.ts";
export type { UnpinnedSource } from "./unpinned.ts";
export type { Exposure, HistorySecret } from "./history.ts";
export type { Location } from "./locations.ts";
export type { Secret } from "./secret.ts";

export async function secretsReport(
  home: Home,
  options: {
    hostHistory: string | false;
    days: number;
    repoHistory?: boolean;
    onRead?: Progress;
    onRepo?: Progress;
  },
) {
  const mask = masker(await machineKey(home.dir));
  const history = await scanHistory(home, mask, options);
  const projects = await repositories(history.cwds);
  const configs = await scanConfigs(home, projects, mask);
  const instructions = await scanInstructions(home, projects, mask);
  const files = await credentialFiles(home, projects, configs.credentials, {
    reads: history.reads,
    printed: history.printed,
    mask,
  });
  const footprints = await wormFootprints(home, projects, mask, options.days);
  const unpinned = await unpinnedSources(home, projects, mask);
  const hooks = await gitHooks(projects, mask);
  const repoHistory = options.repoHistory
    ? await scanRepoHistory(projects, mask, options.onRepo)
    : null;
  return {
    observedAt: new Date().toISOString(),
    projects: projects.length,
    history: {
      sessions: history.sessions,
      unreadable: history.unreadable,
      hostMessages: history.hostMessages,
      secrets: history.secrets.filter((secret) => secret.confidence === "high"),
      lowConfidence: history.secrets.filter((secret) => secret.confidence === "low"),
    },
    configs: configs.files,
    permissions: configs.permissions,
    instructions: { scanned: instructions.scanned, files: instructions.files },
    credentialFiles: files,
    footprints,
    locations: locations({
      history: history.secrets,
      sessionsOf: history.sessionsOf,
      files: [...configs.files, ...instructions.files, ...files],
      env: process.env,
      mask,
    }),
    unpinned: unpinned.found,
    hooks,
    repoHistory,
    warnings: [...new Set([...configs.warnings, ...instructions.warnings, ...unpinned.warnings])],
    limitations: [
      "Everything runs on this machine. No secret, excerpt or finding is sent to Jev, a model or the network.",
      "Values are shown as their first 4 characters and a tag keyed by a random key kept in ~/.quench/local, never in full.",
      "Lower confidence means the generic gitleaks rule or a secret-named value: often real, but also code and test values. They are not counted in the headline or rotate list.",
      "Detection uses the gitleaks ruleset plus an entropy check, so unusual formats can be missed and test values can be reported.",
      "Known projects are the git repositories your sessions ran in; .env files and worm footprints are checked at their top level only.",
      `New install scripts are dependency preinstall, install or postinstall scripts whose package was written in the last ${options.days} days. Known-benign scripts, matched by package name and script hash, are skipped.`,
      "Locations group each value by its tag across files, environment variable names and sessions; lower confidence values seen only in sessions are left out.",
      "Agent read means a session recorded reading that exact path; printed means a value from the file appears in session history.",
      "Unpinned means an MCP server, marketplace, plugin or package started from @latest, no version, a range, or a branch instead of an exact version, tag or commit. Versions to pin to come from the local npx cache when present; Codex plugins record no source to check.",
      "Git hooks are executable hooks in the hooks directory, or core.hooksPath, of each known project; a hook with no known manager's marker was installed by hand or by an unknown tool.",
      options.repoHistory
        ? "Repo history scans every version of every file reachable from any ref of the known projects once, skipping binaries and the paths gitleaks skips (lockfiles, node_modules, vendored code)."
        : "Repo git history is not scanned unless you pass --repo-history, because it is slow on big repositories.",
      "Out of scope: ports, network and OS hardening, persistence and PATH. Use lynis, osquery or trufflehog for those.",
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
