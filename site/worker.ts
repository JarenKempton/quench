const stable = "https://github.com/JarenKempton/quench/releases/latest/download";
const installers = new Set(["/install.sh", "/install.ps1"]);

type Env = { ASSETS: { fetch: (request: Request) => Promise<Response> } };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.quench.sh") {
      url.hostname = "quench.sh";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (!installers.has(url.pathname)) return env.ASSETS.fetch(request);
    const asset = await fetch(stable + url.pathname);
    if (!asset.ok)
      return new Response(`couldn't fetch ${url.pathname} from GitHub\n`, { status: 502 });
    return new Response(asset.body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  },
};
