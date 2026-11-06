import { extname } from "node:path";
import type { Home } from "@quench/history";
import type { Provider } from "@quench/judge";
import { correctionsJson, shownHistory } from "./corrections.ts";
import { readSkillsSource, skillsJson } from "./skills.ts";

export const LOOPBACK = "127.0.0.1";

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

export async function uiAssets(): Promise<Map<string, Blob>> {
  const embedded = await import("@quench/ui/embed").then(
    (m) => m.files,
    () => ({}),
  );
  return new Map(Object.entries(embedded).map(([name, path]) => [name, Bun.file(path)]));
}

const respond = (
  body: Blob | string,
  status: number,
  type = "text/plain; charset=utf-8",
  extra: Record<string, string> = {},
) => new Response(body, { status, headers: { ...HEADERS, ...extra, "content-type": type } });

export class Aged {
  constructor(
    readonly value: unknown,
    readonly computedAt: Date,
  ) {}
}

export const MAX_AGE_MS = 5 * 60_000;

export function lastResult(
  read: () => Promise<unknown>,
  maxAgeMs = MAX_AGE_MS,
  now = () => Date.now(),
): (refresh: boolean) => Promise<Aged> {
  let last: Aged | null = null;
  let running: Promise<Aged> | null = null;
  const run = () =>
    (running ??= read()
      .then((value) => (last = new Aged(value, new Date(now()))))
      .finally(() => {
        running = null;
      }));
  return async (refresh) =>
    running ?? (!last || refresh || now() - last.computedAt.getTime() > maxAgeMs ? run() : last);
}

export type Api = (refresh: boolean) => Promise<unknown>;

export type UiServer = { url: string; port: number; stop: () => Promise<void> };

export function serveUi(options: {
  port: number;
  api: Readonly<Record<string, Api>>;
  assets: ReadonlyMap<string, Blob>;
}): UiServer {
  const server = Bun.serve({
    hostname: LOOPBACK,
    port: options.port,
    async fetch(request) {
      if (request.headers.get("host") !== `${LOOPBACK}:${server.port}`)
        return respond("Host not allowed\n", 421);
      if (request.method !== "GET" && request.method !== "HEAD")
        return respond("Method not allowed\n", 405);
      const url = new URL(request.url);
      const path = url.pathname;
      const api = Object.hasOwn(options.api, path) ? options.api[path] : undefined;
      if (api) {
        server.timeout(request, 0);
        try {
          const result = await api(url.searchParams.get("refresh") === "1");
          if (!(result instanceof Aged))
            return respond(JSON.stringify(result), 200, "application/json");
          return respond(JSON.stringify(result.value), 200, "application/json", {
            "x-quench-computed-at": result.computedAt.toISOString(),
          });
        } catch (error) {
          return respond(`${(error as Error).message}\n`, 500);
        }
      }
      const name = path === "/" ? "index.html" : path.slice(1);
      const asset = !name.includes("/") && options.assets.get(name);
      if (asset) return respond(asset, 200, TYPES[extname(name)]);
      if (path === "/")
        return respond(
          "This build of quench has no UI assets. Run bun run --cwd packages/ui build.\n",
          503,
        );
      return respond("Not found\n", 404);
    },
  });
  return {
    url: `http://${LOOPBACK}:${server.port}/`,
    port: server.port!,
    stop: () => server.stop(true),
  };
}

export const openCommand = (url: string, platform: NodeJS.Platform = process.platform) =>
  platform === "darwin"
    ? ["open", url]
    : platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];

export type UiFlags = {
  days: number;
  cache: boolean;
  port?: string;
  open: boolean;
  source?: string;
  hostHistory?: string | false;
  judge: Provider | null;
};

const NO_JUDGE = { judge: null };

function latest<T>(run: () => Promise<T>) {
  let running: Promise<T> | null = null;
  return () =>
    (running ??= run().finally(() => {
      running = null;
    }));
}

export async function startUi(home: Home, flags: UiFlags): Promise<UiServer | Error> {
  const port = Number(flags.port ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    return new Error("--port must be a whole number from 0 to 65535");
  const source = await readSkillsSource(flags.source);
  if (source instanceof Error) return source;
  const { judge } = flags;
  const api = {
    "/api/skills": latest(() => skillsJson(home, { ...flags, source }).then((r) => r.report)),
    "/api/corrections": lastResult(async () =>
      judge?.id
        ? shownHistory(
            await correctionsJson(home, {
              days: flags.days,
              examples: 10,
              judge,
              ...hostHistory(flags),
            }),
          )
        : NO_JUDGE,
    ),
  };
  try {
    return serveUi({ port, api, assets: await uiAssets() });
  } catch (error) {
    return new Error(
      `quench ui could not listen on ${LOOPBACK}:${port}: ${(error as Error).message}`,
    );
  }
}

const hostHistory = (flags: UiFlags) =>
  flags.hostHistory === undefined ? {} : { hostHistory: flags.hostHistory };

export async function ui(home: Home, flags: UiFlags): Promise<number> {
  const server = await startUi(home, flags);
  if (server instanceof Error) {
    process.stderr.write(`${server.message}\n`);
    return 1;
  }
  process.stdout.write(`quench ui at ${server.url}\nRead-only; Ctrl-C stops it.\n`);
  if (flags.open)
    try {
      Bun.spawn(openCommand(server.url), { stdout: "ignore", stderr: "ignore" });
    } catch {
      process.stdout.write("Could not open a browser; open the address above.\n");
    }
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.stop();
  return 0;
}
