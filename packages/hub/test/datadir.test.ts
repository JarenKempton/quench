import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { importInto } from "../src/index.ts";
import {
  failure,
  HUB_TIMEOUT,
  importedData,
  temp,
  Owner,
  sharedSource,
  startHub,
  stopHubs,
} from "./helpers.ts";

const posix = process.platform !== "win32";
afterEach(stopHubs);

function outsideWith(name: string) {
  const outside = temp("outside");
  chmodSync(outside, 0o755);
  writeFileSync(join(outside, name), "keep\n");
  return outside;
}

const untouched = (outside: string, name: string) => {
  expect(readdirSync(outside)).toEqual([name]);
  expect(readFileSync(join(outside, name), "utf8")).toBe("keep\n");
  if (posix) expect(statSync(outside).mode & 0o777).toBe(0o755);
};

async function importedHub() {
  const data = await importedData();
  const hub = await startHub(data);
  await hub.hub.checkout(await hub.hub.head());
  await hub.stop();
  return data;
}

test(
  "a <data>/checkouts symlink stops the hub from starting and is never written or emptied",
  async () => {
    if (!posix) return;
    const data = await importedHub();
    const outside = outsideWith("keep");
    renameSync(join(data, "checkouts"), join(temp("old"), "checkouts"));
    symlinkSync(outside, join(data, "checkouts"));
    expect(await failure(startHub(data))).toContain("checkouts must be a real folder");
    untouched(outside, "keep");
  },
  HUB_TIMEOUT,
);

test(
  "a <data>/checkouts swapped for a symlink while running gets no writes or deletes",
  async () => {
    if (!posix) return;
    const data = await importedData();
    const hub = await startHub(data);
    await hub.hub.checkout(await hub.hub.head());
    const outside = outsideWith("keep");
    renameSync(join(data, "checkouts"), join(temp("old"), "checkouts"));
    symlinkSync(outside, join(data, "checkouts"));
    const owner = new Owner(hub.url, hub.cert);
    await owner.login();
    const base = await hub.hub.head();
    await hub.hub.writeFile(base, "notes.txt", "x\n", "Add notes");
    expect(await failure(hub.hub.checkout(await hub.hub.head()))).toContain("not a plain folder");
    untouched(outside, "keep");
  },
  HUB_TIMEOUT,
);

test(
  "a <data>/skills.git swapped for a symlink while running stops every git command",
  async () => {
    if (!posix) return;
    const data = await importedData();
    const hub = await startHub(data);
    const head = await hub.hub.head();
    const outside = temp("outside-git");
    renameSync(join(data, "skills.git"), join(outside, "skills.git"));
    symlinkSync(join(outside, "skills.git"), join(data, "skills.git"));
    const before = readdirSync(join(outside, "skills.git")).sort();
    expect(await failure(hub.hub.head())).toContain("not a plain folder");
    expect(await failure(hub.hub.writeFile(head, "notes.txt", "x\n", "Add notes"))).toContain(
      "not a plain folder",
    );
    expect(readdirSync(join(outside, "skills.git")).sort()).toEqual(before);
  },
  HUB_TIMEOUT,
);

test(
  "serve and import refuse a data folder that is a symlink",
  async () => {
    if (!posix) return;
    const real = join(temp("real"), "hub");
    mkdirSync(real, { mode: 0o700 });
    const link = join(temp("link"), "hub");
    symlinkSync(real, link);
    expect(await failure(startHub(link))).toContain("must be a real folder");
    expect(await failure(importInto(link, await sharedSource()))).toContain(
      "must be a real folder",
    );
    expect(readdirSync(real)).toEqual([]);
  },
  HUB_TIMEOUT,
);

test(
  "serve and import refuse a data folder others can read",
  async () => {
    if (!posix) return;
    const data = join(temp("open"), "hub");
    mkdirSync(data, { mode: 0o755 });
    chmodSync(data, 0o755);
    expect(await failure(startHub(data))).toContain("mode 0700");
    expect(await failure(importInto(data, await sharedSource()))).toContain("mode 0700");
    expect(readdirSync(data)).toEqual([]);
  },
  HUB_TIMEOUT,
);

test(
  "a symlink anywhere in the data folder stops the hub",
  async () => {
    if (!posix) return;
    for (const where of [["skills.git", "hooks", "evil"], ["tls"], ["tmp"], ["hub.sqlite"]]) {
      const data = await importedHub();
      const outside = outsideWith("keep");
      const path = join(data, ...where);
      if (existsSync(path)) renameSync(path, join(temp("old"), "moved"));
      symlinkSync(outside, path);
      expect(await failure(startHub(data))).toMatch(/symlink|must be a real folder/);
      untouched(outside, "keep");
    }
  },
  HUB_TIMEOUT,
);

test(
  "a new data folder is created private",
  async () => {
    const data = join(temp("fresh"), "nested", "hub");
    await startHub(data);
    if (posix) expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(existsSync(join(data, "skills.git", "HEAD"))).toBe(true);
  },
  HUB_TIMEOUT,
);

test("hub code writes and deletes data paths only through the safe-path helper", async () => {
  const src = join(import.meta.dir, "../src");
  const writes =
    /(?<![.\w])(?<!async )(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|symlink|link|chmod|chown|copyFile|cp|truncate|open|createWriteStream)(Sync)?\s*\(|Bun\.write\s*\(|\bfs\.\w+\(/;
  const offenders: string[] = [];
  for (const name of readdirSync(src)) {
    if (name === "data.ts" || name === "client.ts") continue;
    readFileSync(join(src, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (writes.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    const imports = /from "node:fs(\/promises)?"/.test(readFileSync(join(src, name), "utf8"));
    if (
      imports &&
      /import \{[^}]*\b(writeFile|mkdir|rm|rename|symlink|chmod|open)\b[^}]*\} from "node:fs/.test(
        readFileSync(join(src, name), "utf8"),
      )
    )
      offenders.push(`${name}: imports fs write functions`);
  }
  expect(offenders).toEqual([]);
});
