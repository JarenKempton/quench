import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Home } from "@quench/history";
import { importInto, serveHub } from "@quench/hub";
import { clientDir, fetchBundle, pair } from "@quench/hub/client";

export type HubOptions = {
  data?: string;
  listen?: string;
  http: boolean;
  url?: string;
  mirror?: string;
  tlsCert?: string;
  tlsKey?: string;
};

const USAGE = `usage: quench hub serve [--data <dir>] [--listen <host:port>] [--url <public url>] [--mirror <git remote>]
                         [--tls-cert <pem> --tls-key <pem> | --http]
       quench hub import <git-url|path> [--data <dir>]
`;

const fail = (message: string) => {
  process.stderr.write(`${message}\n`);
  return 1;
};

function listenOn(raw: string) {
  const match = /^\[?([^\]]*?)\]?:(\d+)$/.exec(raw);
  if (!match) throw new Error("--listen must be <host>:<port>");
  return { hostname: match[1]!, port: Number(match[2]) };
}

export async function hub(home: Home, rest: string[], options: HubOptions) {
  const [sub, ...args] = rest;
  const data = options.data ?? join(home.dir, ".quench", "hub");
  try {
    if (sub === "import" && args.length === 1) {
      const result = await importInto(data, args[0]!);
      process.stdout.write(
        result.skills === null
          ? `Imported ${result.head.slice(0, 12)} with its history; it already has a fleet file\n`
          : `Imported ${result.head.slice(0, 12)} with its history, then converted its manifests to the fleet file in ${result.commit.slice(0, 12)} (${result.skills} skills)\n`,
      );
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
      return 0;
    }
    if (sub === "serve" && args.length === 0) {
      if (!!options.tlsCert !== !!options.tlsKey)
        return fail("--tls-cert and --tls-key go together");
      if (options.http && options.tlsCert) return fail("--http cannot be used with --tls-cert");
      const listen = listenOn(options.listen ?? (options.http ? "127.0.0.1:8080" : "0.0.0.0:8443"));
      const running = await serveHub({
        dataDir: data,
        ...listen,
        http: options.http,
        ...(options.tlsCert && options.tlsKey
          ? {
              tls: {
                cert: await readFile(options.tlsCert, "utf8"),
                key: await readFile(options.tlsKey, "utf8"),
              },
            }
          : {}),
        ...(options.url ? { url: options.url } : {}),
        ...(options.mirror ? { mirror: options.mirror } : {}),
        ...(process.env.QUENCH_HUB_PASSWORD ? { password: process.env.QUENCH_HUB_PASSWORD } : {}),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.stdout.write(`Quench hub at ${running.url}\n`);
      if (running.pin) process.stdout.write(`Certificate pin ${running.pin}\n`);
      await new Promise<void>((done) => {
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
      });
      await running.stop();
      return 0;
    }
  } catch (error) {
    return fail((error as Error).message);
  }
  process.stderr.write(USAGE);
  return 1;
}

export async function connect(
  home: Home,
  rest: string[],
  options: { code?: string; pin?: string },
) {
  if (rest.length !== 1 || !options.code)
    return fail("usage: quench connect <https://hub> --code XXXX-XXXX [--pin sha256:…]");
  const dir = clientDir(home.dir);
  try {
    const connection = await pair(dir, {
      url: rest[0]!,
      code: options.code,
      ...(options.pin ? { pin: options.pin } : {}),
    });
    if (connection.scope === "propose") {
      process.stdout.write(
        `Proposal access to ${connection.url} for ${connection.machine}: agents here can read and propose changes to its assigned skills
`,
      );
      return 0;
    }
    const { bundle, fetched } = await fetchBundle(dir);
    process.stdout.write(
      `Connected to ${connection.url} as ${connection.machine}\nBundle ${bundle.id}: ${Object.keys(bundle.manifest.skills).length} skills, ${bundle.manifest.placements.length} placements, ${fetched} files fetched\n`,
    );
    return 0;
  } catch (error) {
    return fail((error as Error).message);
  }
}
