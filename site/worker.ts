const stable = "https://github.com/JarenKempton/quench/releases/latest/download";
const hosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const maxHops = 5;
const failures = new Map([
  ["/install.sh", 'echo "quench install: download failed" >&2; exit 1\n'],
  ["/install.ps1", 'throw "quench install: download failed"\n'],
]);

type Env = { ASSETS: { fetch: (request: Request) => Promise<Response> } };

async function download(path: string): Promise<string | undefined> {
  let url = new URL(stable + path);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (url.protocol !== "https:" || !hosts.has(url.host)) return undefined;
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location)
      return response.status === 200 ? await response.text() : undefined;
    url = new URL(location, url);
  }
  return undefined;
}

async function installer(path: string, failure: string): Promise<Response> {
  const asset = await download(path).catch(() => undefined);
  if (asset === undefined)
    return new Response(failure, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  return new Response(asset, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "www.quench.sh") {
    url.hostname = "quench.sh";
    url.protocol = "https:";
    return new Response(null, { status: 301, headers: { location: url.toString() } });
  }
  const failure = failures.get(url.pathname);
  return failure ? installer(url.pathname, failure) : env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await route(request, env).catch(
      () =>
        new Response("internal error\n", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        }),
    );
    const secured = new Response(response.body, response);
    secured.headers.set("x-content-type-options", "nosniff");
    secured.headers.set("strict-transport-security", "max-age=31536000");
    return secured;
  },
};
