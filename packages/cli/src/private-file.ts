import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RENAME_TRIES = 40;
const RENAME_RETRY_MS = 25;

const heldByAnother = (error: NodeJS.ErrnoException, platform: NodeJS.Platform) =>
  platform === "win32" &&
  (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");

export async function replacePrivateFile(
  path: string,
  text: string,
  platform: NodeJS.Platform = process.platform,
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, text);
    await chmod(temporary, 0o600);
    for (let tries = 1; ; tries++) {
      try {
        return await move(temporary, path);
      } catch (error) {
        if (!heldByAnother(error as NodeJS.ErrnoException, platform) || tries === RENAME_TRIES)
          throw error;
        await sleep(RENAME_RETRY_MS);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
