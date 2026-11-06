import type { ApplyInput } from "@quench/fleet/apply";
import type { Home } from "@quench/history";
import {
  clientDir,
  fetchBundle,
  loadConnection,
  postSnapshot,
  skillFolders,
  storedBundle,
  type Connection,
  type StoredBundle,
} from "@quench/hub/client";
import { archiveCycle, archiveLine, type ArchiveStatus } from "./agent-archive.ts";
import { applyAndReport, readStatus, writeStatus } from "./agent-cycle.ts";
import type { SkillsOptions } from "./skills.ts";

export type HubLink = {
  url: string | null;
  machine: string | null;
  bundle: string | null;
  revision: string | null;
  lastSync: string | null;
  failedSince: string | null;
  staleSince: string | null;
  error: string | null;
};

const message = (error: unknown) => (error as Error).message;

const text = (value: unknown) => (typeof value === "string" ? value : null);

async function previousLink(home: Home) {
  const hub = (await readStatus(home))?.hub as Record<string, unknown> | undefined;
  return { lastSync: text(hub?.lastSync), failedSince: text(hub?.failedSince) };
}

export async function hubCycle(
  home: Home,
  options: { projects?: string[]; interval: number },
  hooks: Pick<ApplyInput, "now"> = {},
) {
  const dir = clientDir(home.dir);
  const now = new Date();
  const before = await previousLink(home);
  const errors: string[] = [];
  let connection: Connection | null = null;
  let bundle: StoredBundle | null = null;
  let kept = false;
  try {
    ({ connection } = await loadConnection(dir));
  } catch {
    errors.push("not paired with a hub; run quench connect");
  }
  if (connection) {
    try {
      ({ bundle } = await fetchBundle(dir));
    } catch (error) {
      errors.push(`hub unavailable: ${message(error)}`);
      bundle = await storedBundle(dir).catch(() => null);
      kept = bundle !== null;
    }
    if (bundle && bundle.manifest.machine !== connection.machine) bundle = null;
  }
  let apply: SkillsOptions | null = null;
  if (connection && bundle)
    try {
      const sources = await skillFolders(dir, bundle.manifest);
      apply = {
        machine: connection.machine,
        projects: options.projects ?? [],
        bundle: { bundle: bundle.manifest, sources, warnings: [] },
      };
    } catch (error) {
      errors.push(message(error));
    }
  const missed =
    before.lastSync !== null &&
    now.getTime() - Date.parse(before.lastSync) > 2 * options.interval * 1000;
  const staleSince =
    errors.length || before.failedSince || missed
      ? (before.lastSync ?? before.failedSince ?? now.toISOString())
      : null;
  const revision = bundle?.manifest.revision ?? null;
  const report = await applyAndReport(
    home,
    apply,
    { revision, ...(staleSince ? { staleSince } : {}) },
    hooks,
  );
  if (connection)
    await postSnapshot(dir, report.snapshot).catch((error) =>
      errors.push(`snapshot not delivered: ${message(error)}`),
    );
  const archive: ArchiveStatus | null = connection ? await archiveCycle(home, dir) : null;
  const synced = errors.length === 0;
  const hub: HubLink = {
    url: connection?.url ?? null,
    machine: connection?.machine ?? null,
    bundle: bundle?.id ?? null,
    revision,
    lastSync: synced ? report.snapshot.takenAt : before.lastSync,
    failedSince: synced ? null : (before.failedSince ?? now.toISOString()),
    staleSince,
    error: errors.join("; ") || null,
  };
  return writeStatus(home, { version: 1, machine: hub.machine, ...report, kept, hub, archive });
}

export const hubLine = (status: { hub: HubLink; kept: boolean; archive: ArchiveStatus | null }) =>
  (status.archive ? archiveLine(status.archive) : "") +
  (status.hub.error
    ? `; ${status.hub.error}${status.kept ? `; kept bundle ${status.hub.bundle} applied` : ""}`
    : status.hub.staleSince
      ? `; caught up, stale since ${status.hub.staleSince}`
      : "");
