import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  BundleManifest,
  FleetFile,
  mergeSnapshot,
  own,
  resolve,
  sha256,
  treeHash,
  type HarnessId,
  type MachineState,
  type Snapshot,
  type TreeHash,
} from "@quench/fleet";
import { importSkillsRepo } from "@quench/fleet";
import { buildBundle, FLEET_FILE, loadFleet, readSkillsRepo, readTree } from "@quench/fleet/disk";
import shippedSkill from "../../../skills/quench/SKILL.md" with { type: "text" };
import { versionCards, type Reporting } from "./cards.ts";
import { DataDir } from "./data.ts";
import { Repo, type Guard, type Version } from "./git.ts";
import type { CardView, Desired } from "./skill-views.ts";
import { Store, type Identity } from "./store.ts";

export const SHIPPED_SKILL = { name: "quench", path: "skills/quench", content: shippedSkill };

export type SkillAt = { name: string; path: string; treeHash: string; content: string };

const MAX_DIFF = 40_000;

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

  private constructor(
    readonly data: DataDir,
    database: string,
    readonly options: { mirror?: string; now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.repo = new Repo(data);
    this.store = new Store(database, options.now);
  }

  static async open(dataDir: string, options: Hub["options"] = {}) {
    const data = await DataDir.open(dataDir);
    const hub = new Hub(data, await data.ensureFile(["hub.sqlite"]), options);
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
      const dir = this.data.path("checkouts", commit);
      ready = this.repo.materialize(commit, ["checkouts", commit]).then(async () => {
        for (const name of await this.data.list("checkouts"))
          if (name !== commit && !name.includes(".tmp") && !this.checkouts.has(name))
            await this.data.remove("checkouts", name);
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

  async writeFile(
    base: string,
    path: string,
    content: string,
    message: string,
    guard: Guard = () => {},
  ) {
    if (path === FLEET_FILE) FleetFile.parse(Bun.YAML.parse(content));
    return this.committed(await this.repo.commitFile(base, path, content, message, guard));
  }

  async toggle(base: string, skill: string, machine: string, on: boolean, guard: Guard = () => {}) {
    const { fleet } = await this.fleetAt(base);
    if (!own(fleet.skills, skill)) throw new Error(`unknown skill ${skill}`);
    const next = toggled(fleet, skill, machine, on);
    return this.committed(
      await this.repo.commitFile(
        base,
        FLEET_FILE,
        fleetYaml(next),
        `${on ? "Enable" : "Disable"} ${skill} on ${machine}`,
        guard,
      ),
    );
  }

  async revert(base: string, commit: string, guard: Guard = () => {}) {
    return this.committed(await this.repo.revert(base, commit, guard));
  }

  async skillAt(commit: string, name: string): Promise<SkillAt | null> {
    const { fleet } = await this.fleetAt(commit);
    const source = own(fleet.skills, name);
    if (!source) return null;
    const dir = await this.checkout(commit);
    const tree = await readTree(join(dir, ...source.path.split("/"))).catch(() => null);
    const content = await this.repo.show(commit, `${source.path}/SKILL.md`);
    if (!tree || content === null) return null;
    return { name, path: source.path, treeHash: treeHash(tree), content };
  }

  async assignedSkills(machine: string, commit: string) {
    const { manifest } = await this.bundle(machine, commit);
    return Object.entries(manifest.skills)
      .map(([name, skill]) => ({ name, treeHash: skill.treeHash }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async assignedSkill(machine: string, commit: string, name: string): Promise<SkillAt | null> {
    const { manifest } = await this.bundle(machine, commit);
    const bundled = own(manifest.skills, name);
    if (!bundled) return null;
    const skill = await this.skillAt(commit, name);
    return skill && skill.treeHash === bundled.treeHash ? skill : null;
  }

  async addShippedSkill(base: string, guard: Guard = () => {}) {
    const { fleet } = await this.fleetAt(base);
    const { name, path, content } = SHIPPED_SKILL;
    if (own(fleet.skills, name)) throw new Error(`the fleet already has a skill named ${name}`);
    if ((await this.repo.files(base)).some((f) => f.startsWith(`${path}/`)))
      throw new Error(`${path} already exists in the skills repo`);
    const next = FleetFile.parse({ ...fleet, skills: { ...fleet.skills, [name]: { path } } });
    return this.committed(
      await this.repo.commitFiles(
        base,
        [
          { path: `${path}/SKILL.md`, content },
          { path: FLEET_FILE, content: fleetYaml(next) },
        ],
        `Add the shipped ${name} skill`,
        guard,
      ),
    );
  }

  async desired(machines: readonly string[], commit: string): Promise<Desired> {
    const desired: Desired = new Map();
    for (const machine of machines) {
      const skills = new Map<string, Map<HarnessId, TreeHash>>();
      const { manifest } = await this.bundle(machine, commit);
      for (const p of manifest.placements)
        if (p.scope.kind === "global")
          skills.set(p.skill, (skills.get(p.skill) ?? new Map()).set(p.harness, p.treeHash));
      desired.set(machine, skills);
    }
    return desired;
  }

  async cards(fleet: FleetFile, machines: readonly Reporting[]): Promise<CardView[]> {
    const history = new Map<string, Promise<Version[]>>();
    const versionsOf = (path: string) =>
      history.get(path) ?? history.set(path, this.repo.versions(path)).get(path)!;
    return Promise.all(
      versionCards(machines).map(async (card) => {
        const source = own(fleet.skills, card.skill);
        if (!card.shown || !source)
          return { ...card, path: source?.path ?? null, diff: null, revert: null };
        const versions = await versionsOf(source.path);
        const at = (hash: string) => versions.findLast((v) => v.treeHash === hash)?.commit;
        const [before, after] = [at(card.before), at(card.after)];
        const change = versions.find(
          (v, i) => i > 0 && v.treeHash === card.after && versions[i - 1]!.treeHash === card.before,
        );
        const diff =
          before && after ? await this.repo.diffCommits(before, after, source.path) : null;
        return {
          ...card,
          path: source.path,
          diff:
            diff && diff.length > MAX_DIFF
              ? `${diff.slice(0, MAX_DIFF)}\n… diff cut at ${MAX_DIFF} characters`
              : diff,
          revert: change && versions.at(-1)?.treeHash === card.after ? change.commit : null,
        };
      }),
    );
  }

  report(identity: Identity, snapshot: Snapshot): MachineState | null {
    return this.store.report(identity, (previous) => mergeSnapshot(previous, snapshot));
  }
}

export async function importInto(dataDir: string, source: string) {
  const data = await DataDir.open(dataDir);
  const repo = new Repo(data);
  if (await repo.exists())
    throw new Error(`${dataDir} already has a skills repo; import into a new hub data folder`);
  await repo.init();
  const scratch = await repo.scratch("import-");
  try {
    const head = await repo.fetchHead(source);
    await repo.materialize(head, [...scratch.parts, "tree"]);
    const tree = data.path(...scratch.parts, "tree");
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
    await data.remove("skills.git");
    throw error;
  } finally {
    await data.remove(...scratch.parts);
  }
}
