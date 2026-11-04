import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConfigFile, Home } from "@quench/history";
import { detectInFile } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { pathKey } from "./path-key.ts";
import { findingId, secretOf, textOf, tracked, type Secret } from "./secret.ts";

export type CredentialFile = {
  id: string;
  path: string;
  label: string;
  present: boolean;
  plaintext: boolean | null;
  mode: string | null;
  othersCanRead: boolean | null;
  tracked: boolean | null;
  secrets: number;
  values: Secret[];
  readInSessions: number;
  printedInSessions: boolean;
};

const HOME_FILES: [string, string][] = [
  [".npmrc", "npm"],
  [".pypirc", "PyPI"],
  [".git-credentials", "git credentials"],
  [".netrc", "netrc"],
  [".aws/credentials", "AWS"],
  [".kube/config", "kubeconfig"],
  [".docker/config.json", "Docker"],
  [".bash_history", "shell history"],
  [".zsh_history", "shell history"],
  [".local/share/fish/fish_history", "shell history"],
];

type Env = Record<string, string | undefined>;

export function toolConfigFiles(
  homeDir: string,
  platform: NodeJS.Platform,
  env: Env,
): [string, string][] {
  const appData = env.APPDATA || join(homeDir, "AppData", "Roaming");
  const config = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  const gh =
    env.GH_CONFIG_DIR || (platform === "win32" ? join(appData, "GitHub CLI") : join(config, "gh"));
  const gcloud =
    env.CLOUDSDK_CONFIG ||
    (platform === "win32" ? join(appData, "gcloud") : join(homeDir, ".config", "gcloud"));
  return [
    [join(gh, "hosts.yml"), "GitHub CLI"],
    [join(gcloud, "application_default_credentials.json"), "gcloud ADC"],
  ];
}

type Seen = { reads: Map<string, Set<string>>; printed: Set<string>; mask: Masker };

export async function credentialFiles(
  home: Home,
  projects: readonly string[],
  harnessFiles: readonly ConfigFile[],
  seen: Seen,
): Promise<CredentialFile[]> {
  const candidates: [string, string][] = [
    ...HOME_FILES.map(([path, label]): [string, string] => [join(home.dir, path), label]),
    ...toolConfigFiles(home.dir, process.platform, process.env),
    ...harnessFiles.map((file): [string, string] => [file.path, "agent login"]),
    ...(await filesIn(join(home.dir, ".azure"), (name) => name.endsWith(".json"))).map(
      (path): [string, string] => [path, "Azure"],
    ),
    ...(
      await filesIn(join(home.dir, ".zsh_sessions"), (name) => /\.history(new)?$/.test(name))
    ).map((path): [string, string] => [path, "shell history"]),
  ];
  for (const project of projects)
    for (const path of await filesIn(project, (name) => /^\.env(\..+)?$/.test(name)))
      candidates.push([path, ".env"]);
  const files = await Promise.all(candidates.map(([path, label]) => inspect(path, label, seen)));
  const keys = await sshKeys(join(home.dir, ".ssh"), seen);
  return [...files, ...keys];
}

async function inspect(path: string, label: string, seen: Seen): Promise<CredentialFile> {
  const info = await stat(path).catch(() => null);
  const text = info?.isFile() ? await textOf(path) : null;
  const found = text === null ? [] : detectInFile(text, path);
  return {
    id: findingId(seen.mask, path),
    path,
    label,
    present: info !== null,
    plaintext: text === null ? null : found.length > 0,
    ...modeOf(info?.mode),
    tracked: label === ".env" && found.length ? await tracked(basename(path), dirname(path)) : null,
    secrets: found.length,
    values: found.map((d) => secretOf(d, seen.mask, path)),
    readInSessions: seen.reads.get(pathKey(path))?.size ?? 0,
    printedInSessions: found.some((d) => seen.printed.has(seen.mask.id(d.value))),
  };
}

async function sshKeys(dir: string, seen: Seen): Promise<CredentialFile[]> {
  const files = await filesIn(dir, () => true);
  const keys: CredentialFile[] = [];
  for (const path of files) {
    const info = await stat(path);
    if (info.size > 65_536) continue;
    const text = await textOf(path);
    if (!text?.includes("PRIVATE KEY-----")) continue;
    const found = detectInFile(text, path);
    keys.push({
      id: findingId(seen.mask, path),
      path,
      label: "SSH key",
      present: true,
      plaintext: sshKeyEncrypted(text) === false,
      ...modeOf(info.mode),
      tracked: null,
      secrets: found.length,
      values: found.map((d) => secretOf(d, seen.mask, path)),
      readInSessions: seen.reads.get(pathKey(path))?.size ?? 0,
      printedInSessions: found.some((d) => seen.printed.has(seen.mask.id(d.value))),
    });
  }
  return keys;
}

export function sshKeyEncrypted(text: string): boolean | null {
  if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(text)) return true;
  const body = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END/.exec(text)?.[1];
  if (body) {
    const raw = Buffer.from(body.replace(/\s/g, ""), "base64");
    if (raw.subarray(0, 15).toString() !== "openssh-key-v1\0" || raw.length < 19) return null;
    return raw.subarray(19, 19 + raw.readUInt32BE(15)).toString() !== "none";
  }
  return /BEGIN (?:RSA |EC |DSA )?PRIVATE KEY/.test(text) ? false : null;
}

function modeOf(mode: number | undefined) {
  if (mode === undefined || process.platform === "win32")
    return { mode: null, othersCanRead: null };
  return { mode: (mode & 0o777).toString(8), othersCanRead: (mode & 0o044) !== 0 };
}

async function filesIn(dir: string, wanted: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && wanted(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}
