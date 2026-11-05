import { mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleManifest,
  FleetFile,
  mergeSnapshot,
  own,
  resolve,
  sha256,
  type MachineState,
  type Snapshot,
} from "@quench/fleet";
import { importSkillsRepo } from "@quench/fleet";
import { buildBundle, FLEET_FILE, loadFleet, readSkillsRepo } from "@quench/fleet/disk";
import { Repo } from "./git.ts";
import { Store } from "./store.ts";

export const EMPTY_FLEET = "version: 1\nskills: {}\n";

export const fleetYaml = (fleet: FleetFile) => `${Bun.YAML.stringify(fleet, null, 2)}\n`;

export type Bundle = { id: string; manifest: BundleManifest; json: string };

export function toggled(fleet: FleetFile, skill: string, machine: string, on: boolean): FleetFile {
  const mine = (a: FleetFile["assignments"][number]) =>
    a.skill === skill &&
    a.target.kind === "machine" &&
    a.target.machine === machine &&
    a.scope.kind === "global";
  const kept: FleetFile = { ...fleet, assignments: fleet.assignments.filter((a) => !mine(a)) };
  if (placed(kept, skill, machine) === on) return FleetFile.parse(kept);
  return FleetFile.parse({
    ...kept,
    assignments: [
      ...kept.assignments,
      {
        skill,
        target: { kind: "machine", machine },
        scope: { kind: "global" },
        harnesses: "all",
        mode: on ? "include" : "exclude",
      },
    ],
  });
}

export const placed = (fleet: FleetFile, skill: string, machine: string) =>
  resolve(fleet, machine).placements.some((p) => p.skill === skill && p.scope.kind === "global");

export class Hub {
  readonly repo: Repo;
  readonly store: Store;
  private bundles = new Map<string, Promise<Bundle>>();
  private checkouts = new Map<string, Promise<string>>();
  private pushing: Promise<void> = Promise.resolve();

  constructor(
    readonly dataDir: string,
    readonly options: { mirror?: string; now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.repo = new Repo(join(dataDir, "skills.git"));
    this.store = new Store(join(dataDir, "hub.sqlite"), options.now);
  }

  static async open(dataDir: string, options: Hub["options"] = {}) {
    await mkdir(dataDir, { recursive: true });
    const hub = new Hub(dataDir, options);
    if (!(await hub.repo.exists())) await hub.repo.init();
    if (!(await hub.repo.head()))
      await hub.repo.commitFile(null, FLEET_FILE, EMPTY_FLEET, "Start an empty fleet");
    return hub;
  }

  close() {
    this.store.close();
  }

  async head() {
    const head = await this.repo.head();
    if (!head) throw new Error("the hub's skills repo has no commits");
    return head;
  }

  async checkout(commit: string) {
    let ready = this.checkouts.get(commit);
    if (!ready) {
      const dir = join(this.dataDir, "checkouts", commit);
      ready = this.repo.materialize(commit, dir).then(async () => {
        for (const name of await readdir(join(this.dataDir, "checkouts")))
          if (name !== commit && !name.endsWith(".tmp") && !this.checkouts.has(name))
            await rm(join(this.dataDir, "checkouts", name), { recursive: true, force: true });
        return dir;
      });
      ready.catch(() => this.checkouts.delete(commit));
      this.checkouts.set(commit, ready);
      for (const old of [...this.checkouts.keys()].slice(0, -3)) this.checkouts.delete(old);
    }
    return ready;
  }

  async fleetAt(commit: string) {
    return loadFleet(await this.checkout(commit));
  }

  bundle(machine: string, commit: string): Promise<Bundle> {
    const key = `${commit}\0${machine}`;
    let found = this.bundles.get(key);
    if (!found) {
      found = (async () => {
        const dir = await this.checkout(commit);
        const { fleet } = await loadFleet(dir);
        const { bundle } = await buildBundle(dir, fleet, machine, commit);
        const manifest = BundleManifest.parse(bundle);
        const json = JSON.stringify(manifest);
        return { id: `sha256:${sha256(json)}`, manifest, json };
      })();
      found.catch(() => this.bundles.delete(key));
      this.bundles.set(key, found);
      if (this.bundles.size > 256) this.bundles.delete(this.bundles.keys().next().value!);
    }
    return found;
  }

  async blob(machine: string, digest: string): Promise<Uint8Array | null> {
    const commit = await this.head();
    const { manifest } = await this.bundle(machine, commit);
    const { fleet } = await this.fleetAt(commit);
    const dir = await this.checkout(commit);
    for (const [name, skill] of Object.entries(manifest.skills)) {
      const file = skill.files.find((f) => f.sha256 === digest);
      const source = own(fleet.skills, name);
      if (!file || !source) continue;
      const path = join(dir, ...source.path.split("/"), ...file.path.split("/"));
      const bytes =
        file.mode === "120000"
          ? Buffer.from(await readlink(path, { encoding: "buffer" }))
          : await readFile(path);
      if (sha256(bytes) === digest) return bytes;
    }
    return null;
  }

  mirror() {
    const remote = this.options.mirror;
    if (remote)
      this.pushing = this.pushing.then(() =>
        this.repo
          .push(remote)
          .catch((error: Error) => this.options.log?.(`mirror push failed: ${error.message}`)),
      );
  }

  private committed(commit: string) {
    this.mirror();
    return commit;
  }

  mirrored() {
    return this.pushing;
  }

  async writeFile(base: string, path: string, content: string, message: string) {
    if (path === FLEET_FILE) FleetFile.parse(Bun.YAML.parse(content));
    return this.committed(await this.repo.commitFile(base, path, content, message));
  }

  async toggle(base: string, skill: string, machine: string, on: boolean) {
    const { fleet } = await this.fleetAt(base);
    if (!own(fleet.skills, skill)) throw new Error(`unknown skill ${skill}`);
    const next = toggled(fleet, skill, machine, on);
    return this.committed(
      await this.repo.commitFile(
        base,
        FLEET_FILE,
        fleetYaml(next),
        `${on ? "Enable" : "Disable"} ${skill} on ${machine}`,
      ),
    );
  }

  async revert(base: string, commit: string) {
    return this.committed(await this.repo.revert(base, commit));
  }

  report(machine: string, snapshot: Snapshot): MachineState | null {
    return this.store.db.transaction(() => {
      if (!this.store.activeMachine(machine)) return null;
      const next = mergeSnapshot(this.store.machineState(machine), snapshot);
      this.store.saveState(machine, next);
      return next;
    })();
  }
}

export async function importInto(dataDir: string, source: string) {
  const repo = new Repo(join(dataDir, "skills.git"));
  if (await repo.exists())
    throw new Error(`${dataDir} already has a skills repo; import into a new hub data folder`);
  await mkdir(dataDir, { recursive: true });
  await repo.init();
  const scratch = await mkdtemp(join(tmpdir(), "quench-hub-import-"));
  try {
    const head = await repo.fetchHead(source);
    const tree = join(scratch, "tree");
    await repo.materialize(head, tree);
    if ((await repo.show(head, FLEET_FILE)) !== null)
      return { head, commit: head, warnings: [] as string[], skills: null };
    const found = await readSkillsRepo(tree);
    if (!found) throw new Error(`${source} has neither ${FLEET_FILE} nor registry.yaml`);
    const { fleet, warnings } = importSkillsRepo(found);
    const commit = await repo.commitFile(
      head,
      FLEET_FILE,
      fleetYaml(fleet),
      "Convert registry and host manifests to the fleet file",
    );
    return { head, commit, warnings, skills: Object.keys(fleet.skills).length };
  } catch (error) {
    await rm(repo.dir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
