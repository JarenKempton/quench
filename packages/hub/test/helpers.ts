import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHub, type ServeOptions } from "../src/server.ts";

export const PASSWORD = "correct horse battery";

export const temp = (name: string) => mkdtempSync(join(tmpdir(), `quench-hub-${name}-`));

export const fixtureRepo = join(import.meta.dir, "../../fleet/test/fixtures/skills-repo");

export async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

export async function skillsSource() {
  const dir = join(temp("source"), "skills");
  cpSync(fixtureRepo, dir, { recursive: true });
  await git(dir, "init", "--quiet");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "Add skills");
  await Bun.write(
    join(dir, "skills/writing/commit-style/SKILL.md"),
    "---\nname: commit-style\ndescription: Write conventional commits.\n---\n\nUse conventional commits, revised.\n",
  );
  await git(dir, "commit", "--quiet", "-am", "Revise commit-style");
  return dir;
}

export type Running = Awaited<ReturnType<typeof serveHub>>;

export async function startHub(dataDir: string, options: Partial<ServeOptions> = {}) {
  return serveHub({
    dataDir,
    hostname: "127.0.0.1",
    port: 0,
    password: PASSWORD,
    ...options,
  });
}

export class Owner {
  cookie = "";
  csrf = "";
  constructor(
    readonly url: string,
    readonly cert: string | null,
  ) {}

  fetch(path: string, init: RequestInit = {}) {
    return fetch(`${this.url}${path}`, {
      redirect: "manual",
      ...init,
      headers: {
        origin: this.url,
        cookie: this.cookie,
        ...(init.headers as Record<string, string>),
      },
      ...(this.cert ? { tls: { ca: this.cert } } : {}),
    });
  }

  post(path: string, fields: Record<string, string>) {
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: this.csrf, ...fields }).toString(),
    });
  }

  async login(password = PASSWORD) {
    const response = await this.post("/login", { password });
    this.cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    if (this.cookie) {
      const html = await (await this.fetch("/")).text();
      this.csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? "";
    }
    return response;
  }

  async head() {
    const html = await (await this.fetch("/")).text();
    return /name="base" value="([0-9a-f]{40})"/.exec(html)![1]!;
  }

  async addMachine(name: string) {
    const html = await (await this.post("/machines", { name })).text();
    const command = /<pre id="connect">([^<]+)<\/pre>/.exec(html)?.[1] ?? "";
    return {
      command,
      code: / --code (\S+)/.exec(command)?.[1] ?? "",
      pin: / --pin (\S+)/.exec(command)?.[1],
      url: /^quench connect (\S+)/.exec(command)?.[1] ?? "",
    };
  }
}

export const snapshot = (generation: number, harnesses: Record<string, unknown>) => ({
  version: 1,
  id: crypto.randomUUID(),
  generation,
  takenAt: new Date().toISOString(),
  revision: null,
  harnesses,
});

export const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: Error) => error.message,
  );
