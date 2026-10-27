import { chmod, realpath, rename, rm } from "node:fs/promises";
import { $ } from "bun";

const REPO = "JarenKempton/quench";

export async function update(current: string, channel?: string): Promise<number> {
  const fail = (line: string) => (process.stderr.write(`${line}\n`), 1);
  if (!import.meta.path.startsWith("/$bunfs/"))
    return fail("This quench runs from source. Update it with git pull, then bunx vp run compile.");
  const nightly = (channel ?? (current.includes("-nightly.") ? "nightly" : "stable")) === "nightly";
  const asset = `quench-${process.platform}-${process.arch}`;
  const executable = await realpath(process.execPath);
  const staged = `${executable}.update`;
  const download =
    await $`gh release download ${nightly ? ["nightly"] : []} --repo ${REPO} --pattern ${asset} --output ${staged} --clobber`
      .nothrow()
      .quiet();
  if (download.exitCode !== 0)
    return fail(
      `Couldn't download ${asset} with gh: ${download.stderr.toString().trim()}\nquench update needs the GitHub CLI, signed in with gh auth login.`,
    );
  await chmod(staged, 0o755);
  const next = (await $`${staged} --version`.nothrow().quiet().text())
    .trim()
    .replace("quench ", "");
  if (next === current) {
    await rm(staged);
    process.stdout.write(`quench ${current} is up to date.\n`);
    return 0;
  }
  await rename(staged, executable);
  process.stdout.write(`Updated quench ${current} → ${next}.\n`);
  return 0;
}
