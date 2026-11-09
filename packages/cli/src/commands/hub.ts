import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Home } from "@quench/history";
import { DEFAULT_RETENTION, retentionInterval } from "@quench/fleet";
import { importInto, serveHub, type ArchiveOptions } from "@quench/hub";
import { clientDir, fetchBundle, pair } from "@quench/hub/client";

export type HubOptions = {
  data?: string;
  listen?: string;
  http: boolean;
  url?: string;
  mirror?: string;
  tlsCert?: string;
  tlsKey?: string;
  retention?: string;
  clickhouse?: string;
  clickhouseBin?: string;
  clickhouseData?: string;
  clickhousePort?: string;
};

function archiveOf(options: HubOptions, data: string): ArchiveOptions | undefined {
  const retention = options.retention ?? DEFAULT_RETENTION;
  retentionInterval(retention);
  if (options.clickhouse && options.clickhouseBin)
    throw new Error(
      "use --clickhouse-bin to run ClickHouse, or --clickhouse <url> for one already running, not both",
    );
  if ((options.clickhouseData || options.clickhousePort) && !options.clickhouseBin)
    throw new Error("--clickhouse-data and --clickhouse-port go with --clickhouse-bin");
  if (options.retention && !options.clickhouse && !options.clickhouseBin)
    throw new Error("--retention needs --clickhouse-bin or --clickhouse");
  if (options.clickhouseBin) {
    const port = Number(options.clickhousePort ?? 8123);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("--clickhouse-port must be a port number");
    return {
      bin: options.clickhouseBin,
      dir: options.clickhouseData ?? `${data.replace(/[\\/]+$/, "")}-clickhouse`,
      port,
      retention,
    };
  }
  if (options.clickhouse)
    return {
      url: options.clickhouse,
      user: process.env.QUENCH_CLICKHOUSE_USER || "default",
      password: process.env.QUENCH_CLICKHOUSE_PASSWORD ?? "",
      retention,
    };
  return undefined;
}

const USAGE = `usage: quench hub serve [--data <dir>] [--listen <host:port>] [--url <public url>] [--mirror <git remote>]
                         [--tls-cert <pem> --tls-key <pem> | --http]
                         [--clickhouse-bin <path> [--clickhouse-data <dir>] [--clickhouse-port 8123] | --clickhouse <url>]
                         [--retention 5y]
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
      const archive = archiveOf(options, data);
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
        ...(archive ? { archive } : {}),
        ...(process.env.QUENCH_HUB_PASSWORD ? { password: process.env.QUENCH_HUB_PASSWORD } : {}),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.stdout.write(`Quench hub at ${running.url}\n`);
      if (running.pin) process.stdout.write(`Certificate pin ${running.pin}\n`);
      if (archive)
        process.stdout.write(
          `Archive in ClickHouse, kept for ${archive.retention}${"bin" in archive ? ` (data in ${archive.dir})` : ""}\n`,
        );
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
