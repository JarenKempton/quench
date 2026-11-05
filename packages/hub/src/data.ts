import { constants, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export class UnsafeDataDir extends Error {}

const POSIX = process.platform !== "win32";
const NOFOLLOW = POSIX ? constants.O_NOFOLLOW : 0;
const DERIVED = ["checkouts", "tmp"];

const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null;
  throw error;
};

const owned = (info: Stats) => !POSIX || !process.getuid || info.uid === process.getuid();

const segment = (part: string) =>
  part !== "" && part !== "." && part !== ".." && !["/", "\\", "\0"].some((c) => part.includes(c));

const segments = (path: string) => {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return POSIX ? parts : parts.map((p) => p.toLowerCase());
};

export const contains = (root: string, path: string) => {
  const base = segments(realpathSync.native(root));
  const inner = segments(realpathSync.native(path));
  return base.length <= inner.length && base.every((part, i) => inner[i] === part);
};

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

export class DataDir {
  private constructor(readonly root: string) {}

  static async open(dir: string) {
    const top = await lstat(dir).catch(absent);
    if (!top) {
      await mkdir(dirname(dir), { recursive: true });
      await mkdir(dir, { mode: 0o700 });
    }
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new UnsafeDataDir(`${dir} must be a real folder, not a link or file`);
    if (!owned(info)) throw new UnsafeDataDir(`${dir} must be owned by the user running the hub`);
    if (POSIX && info.mode & 0o077)
      throw new UnsafeDataDir(
        `${dir} must be private to the hub user (mode 0700); run chmod 700 ${dir}`,
      );
    const data = new DataDir(realpathSync.native(dir));
    for (const name of DERIVED) {
      const derived = await lstat(join(data.root, name)).catch(absent);
      if (derived && (derived.isSymbolicLink() || !derived.isDirectory()))
        throw new UnsafeDataDir(`${join(dir, name)} must be a real folder, not a link or file`);
      if (derived) await rm(join(data.root, name), { recursive: true, force: true });
    }
    await data.refuseLinks("");
    return data;
  }

  private async refuseLinks(rel: string) {
    for (const entry of await readdir(join(this.root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new UnsafeDataDir(
          `${join(this.root, path)} is a symlink; the hub's data folder must contain none`,
        );
      if (entry.isDirectory()) await this.refuseLinks(path);
    }
  }

  path(...parts: string[]) {
    if (!parts.every(segment)) throw new UnsafeDataDir(`bad data path ${parts.join("/")}`);
    return join(this.root, ...parts);
  }

  private async plainDir(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !owned(info) || !contains(this.root, path))
      throw new UnsafeDataDir(`${path} is not a plain folder of the hub's own`);
  }

  async dir(...parts: string[]) {
    let path = this.root;
    await this.plainDir(path);
    for (let i = 1; i <= parts.length; i++) {
      path = this.path(...parts.slice(0, i));
      const info = await lstat(path).catch(absent);
      if (!info)
        await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await this.plainDir(path);
    }
    return path;
  }

  async fresh(parent: string[], prefix: string) {
    await this.dir(...parent);
    const name = `${prefix}${random()}`;
    const path = this.path(...parent, name);
    await mkdir(path, { mode: 0o700 });
    await this.plainDir(path);
    return { path, parts: [...parent, name] };
  }

  async write(parts: string[], data: string | Uint8Array, mode = 0o600) {
    await this.dir(...parts.slice(0, -1));
    const handle = await open(
      this.path(...parts),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(data);
      if (POSIX) await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }

  async link(parts: string[], target: string) {
    await this.dir(...parts.slice(0, -1));
    await symlink(target, this.path(...parts));
  }

  async read(parts: string[]) {
    const path = this.path(...parts);
    await this.dir(...parts.slice(0, -1));
    const info = await lstat(path).catch(absent);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isFile())
      throw new UnsafeDataDir(`${path} is not a plain file`);
    return readFile(path);
  }

  async ensureFile(parts: string[]) {
    const path = this.path(...parts);
    await this.dir(...parts.slice(0, -1));
    const info = await lstat(path).catch(absent);
    if (!info) await this.write(parts, "");
    else if (info.isSymbolicLink() || !info.isFile() || !owned(info))
      throw new UnsafeDataDir(`${path} is not a plain file of the hub's own`);
    return path;
  }

  async list(...parts: string[]) {
    return readdir(await this.dir(...parts));
  }

  async remove(...parts: string[]) {
    await this.dir(...parts.slice(0, -1));
    await rm(this.path(...parts), { recursive: true, force: true });
  }

  async move(from: string[], to: string[]) {
    await this.dir(...from.slice(0, -1));
    await this.dir(...to.slice(0, -1));
    const info = await lstat(this.path(...from));
    if (info.isSymbolicLink()) throw new UnsafeDataDir(`${this.path(...from)} is a link`);
    await rename(this.path(...from), this.path(...to));
  }
}
