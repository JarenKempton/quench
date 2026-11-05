import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetFile } from "@quench/fleet";
import { importInto, toggled } from "../src/index.ts";
import { failure, git, Owner, skillsSource, startHub, temp, type Running } from "./helpers.ts";

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function hubWithSkills(options: Parameters<typeof startHub>[1] = {}) {
  const data = join(temp("data"), "hub");
  await importInto(data, await skillsSource());
  const hub = await startHub(data, options);
  running.push(hub);
  const owner = new Owner(hub.url, hub.cert);
  await owner.login();
  return { hub, owner, data };
}

const PATH = "skills/writing/commit-style/SKILL.md";
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

test("the editor shows a diff before it saves one commit", async () => {
  const { hub, owner } = await hubWithSkills();
  const before = await hub.hub.head();
  const page = await (await owner.fetch(`/edit?path=${encodeURIComponent(PATH)}`)).text();
  expect(page).toContain("revised");
  const content =
    "---\nname: commit-style\ndescription: Write conventional commits.\n---\n\nShort subjects.\n";
  const skipped = await owner.post("/edit", { path: PATH, base: before, content, action: "save" });
  expect(skipped.status).toBe(200);
  const preview = await skipped.text();
  expect(preview).toContain('<span class="add">+Short subjects.</span>');
  expect(preview).toContain('<span class="del">-Use conventional commits, revised.</span>');
  expect(await hub.hub.head()).toBe(before);

  const changedAfterPreview = await owner.post("/edit", {
    path: PATH,
    base: before,
    content: `${content}More.\n`,
    previewed: field(preview, "previewed"),
    action: "save",
  });
  expect(changedAfterPreview.status).toBe(200);
  expect(await hub.hub.head()).toBe(before);

  const saved = await owner.post("/edit", {
    path: PATH,
    base: before,
    content: content.replaceAll("\n", "\r\n"),
    previewed: field(preview, "previewed"),
    action: "save",
  });
  expect(saved.status).toBe(303);
  const after = await hub.hub.head();
  expect(await hub.hub.repo.show(after, PATH)).toBe(content);
  expect((await hub.hub.repo.log(1))[0]!.subject).toBe(`Edit ${PATH}`);
  expect(await git(".", "--git-dir", hub.hub.repo.dir, "rev-parse", `${after}^`)).toBe(before);
});

test("a stale edit is rejected", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  await hub.hub.writeFile(base, "notes.txt", "one\n", "Add notes");
  const content = "two\n";
  const preview = await (
    await owner.post("/edit", { path: "notes.txt", base, content, action: "preview" })
  ).text();
  const stale = await owner.post("/edit", {
    path: "notes.txt",
    base,
    content,
    previewed: field(preview, "previewed"),
    action: "save",
  });
  expect(stale.status).toBe(409);
  expect(await hub.hub.repo.show(await hub.hub.head(), "notes.txt")).toBe("one\n");
});

test("an invalid fleet file is never committed", async () => {
  const { hub, owner } = await hubWithSkills();
  const base = await hub.hub.head();
  const content = "version: 2\nskills: {}\n";
  const preview = await owner.post("/edit", {
    path: "quench-fleet.yaml",
    base,
    content,
    action: "preview",
  });
  expect(preview.status).toBe(400);
  expect(await preview.text()).toContain("not a valid fleet file");
  expect(await failure(hub.hub.writeFile(base, "quench-fleet.yaml", content, "x"))).not.toBe("");
  expect(await hub.hub.head()).toBe(base);
  expect((await owner.fetch("/edit?path=..%2Fescape")).status).toBe(400);
  expect((await owner.fetch("/edit?path=.git%2Fconfig")).status).toBe(400);
});

test("revert from the UI rolls a toggle back as a new commit", async () => {
  const { hub, owner } = await hubWithSkills();
  const start = await hub.hub.head();
  await owner.post("/toggle", { base: start, skill: "commit-style", machine: "desktop", on: "0" });
  const off = await hub.hub.head();
  expect(Object.keys((await hub.hub.bundle("desktop", off)).manifest.skills)).not.toContain(
    "commit-style",
  );
  expect((await owner.post("/revert", { base: off, commit: off })).status).toBe(303);
  const back = await hub.hub.head();
  expect((await hub.hub.repo.log(1))[0]!.subject).toBe('Revert "Disable commit-style on desktop"');
  expect(await hub.hub.repo.show(back, "quench-fleet.yaml")).toBe(
    await hub.hub.repo.show(start, "quench-fleet.yaml"),
  );
  expect((await owner.post("/revert", { base: off, commit: off })).status).toBe(409);
});

test("toggles change only the one machine's assignment", () => {
  const fleet = FleetFile.parse({
    version: 1,
    skills: { a: { path: "skills/a" } },
    assignments: [
      {
        skill: "a",
        target: { kind: "all" },
        scope: { kind: "global" },
        harnesses: "all",
        mode: "include",
      },
    ],
  });
  const off = toggled(fleet, "a", "laptop", false);
  expect(off.assignments.at(-1)).toEqual({
    skill: "a",
    target: { kind: "machine", machine: "laptop" },
    scope: { kind: "global" },
    harnesses: "all",
    mode: "exclude",
  });
  expect(toggled(off, "a", "laptop", true)).toEqual(fleet);
  expect(toggled(fleet, "a", "laptop", true)).toEqual(fleet);
});

test("every commit is pushed to the optional mirror", async () => {
  const mirror = join(temp("mirror"), "mirror.git");
  await git(".", "init", "--quiet", "--bare", mirror);
  const { hub, owner } = await hubWithSkills({ mirror });
  await hub.hub.mirrored();
  expect(await git(".", "--git-dir", mirror, "rev-parse", "main")).toBe(await hub.hub.head());
  await owner.post("/toggle", {
    base: await hub.hub.head(),
    skill: "scratchpad",
    machine: "laptop",
    on: "0",
  });
  await hub.hub.mirrored();
  const head = await hub.hub.head();
  expect(await git(".", "--git-dir", mirror, "rev-parse", "main")).toBe(head);
  expect(await git(".", "--git-dir", mirror, "log", "--format=%s", "-1", "main")).toBe(
    "Disable scratchpad on laptop",
  );
});

test("import refuses a hub that already has skills", async () => {
  const data = join(temp("data"), "hub");
  const source = await skillsSource();
  await importInto(data, source);
  expect(await failure(importInto(data, source))).toContain("already has a skills repo");
});
