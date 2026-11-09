import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate } from "node:crypto";
import { z } from "zod";
import {
  BundleManifest,
  MachineName,
  sha256,
  SkillName,
  treeHash,
  TreeHash,
  type ProposalSubmission,
  type SessionResult,
  type TaskResult,
  type Snapshot,
  type TranscriptUpload,
} from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";
import { spkiPin } from "./cert.ts";
import { isLoopback } from "./loopback.ts";

export const Connection = z
  .object({
    version: z.literal(1),
    url: z.url(),
    machine: MachineName,
    cert: z.string().nullable(),
  })
  .strict();
export type Connection = z.infer<typeof Connection>;

export const StoredBundle = z.object({ id: z.string(), manifest: BundleManifest }).strict();
export type StoredBundle = z.infer<typeof StoredBundle>;

export const Pin = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const clientDir = (homeDir: string) => join(homeDir, ".quench", "fleet");

const paths = (dir: string) => ({
  connection: join(dir, "connection.json"),
  token: join(dir, "token"),
  proposeToken: join(dir, "propose-token"),
  bundle: join(dir, "bundle.json"),
  blobs: join(dir, "blobs"),
  trees: join(dir, "trees"),
});

async function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export function hubUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    throw new Error("plain http:// is only allowed for a hub on this machine (loopback)");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("the hub URL must start with https://");
  return url.origin;
}

function peerCertificate(url: URL): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((done, fail) => {
    const socket = tlsConnect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
    });
    socket.setTimeout(10_000, () =>
      socket.destroy(new Error("timed out reading the hub's certificate")),
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate().raw;
      socket.destroy();
      if (!raw) fail(new Error("the hub sent no certificate"));
      else done(new X509Certificate(raw).toString());
    });
  });
}

export async function pinnedCertificate(origin: string, pin: string | undefined) {
  const url = new URL(origin);
  if (url.protocol === "http:" || !pin) return null;
  const cert = await peerCertificate(url);
  if (spkiPin(cert) !== pin)
    throw new Error(
      `the hub's certificate is ${spkiPin(cert)}, not the --pin given; not connecting`,
    );
  return cert;
}

const call = (connection: Pick<Connection, "url" | "cert">, path: string, init: RequestInit = {}) =>
  fetch(`${connection.url}${path}`, {
    ...init,
    redirect: "error",
    ...(connection.cert ? { tls: { ca: connection.cert } } : {}),
  });

async function failure(response: Response, what: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new Error(`${what}: ${response.status} ${body?.error ?? response.statusText}`);
}

export async function loadConnection(dir: string) {
  const p = paths(dir);
  const connection = Connection.parse(JSON.parse(await readFile(p.connection, "utf8")));
  const token = (await readFile(p.token, "utf8")).trim();
  return { connection, token };
}

export async function pair(dir: string, input: { url: string; code: string; pin?: string }) {
  const url = hubUrl(input.url);
  if (input.pin !== undefined && !Pin.safeParse(input.pin).success)
    throw new Error("--pin must look like sha256:<64 hex characters>");
  const cert = await pinnedCertificate(url, input.pin);
  const response = await call({ url, cert }, "/api/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code }),
  });
  if (!response.ok) throw await failure(response, "pairing refused");
  const { machine, token, scope } = z
    .object({
      machine: MachineName,
      token: z.string().min(16),
      scope: z.enum(["machine", "propose"]).default("machine"),
    })
    .parse(await response.json());
  const p = paths(dir);
  await mkdir(dir, { recursive: true });
  const connection: Connection = { version: 1, url, machine, cert };
  if (scope === "propose") {
    const existing = await readFile(p.connection, "utf8").catch(() => null);
    const known = existing === null ? null : Connection.parse(JSON.parse(existing));
    if (known && (known.url !== url || known.machine !== machine))
      throw new Error(
        `this machine is connected to ${known.url} as ${known.machine}; proposal access is for ${url} as ${machine}`,
      );
    await atomicWrite(p.proposeToken, `${token}\n`, 0o600);
    if (!known) await atomicWrite(p.connection, `${JSON.stringify(connection, null, 2)}\n`);
    return { ...(known ?? connection), scope };
  }
  await atomicWrite(p.token, `${token}\n`, 0o600);
  await atomicWrite(p.connection, `${JSON.stringify(connection, null, 2)}\n`);
  return { ...connection, scope };
}

async function proposer(dir: string) {
  const p = paths(dir);
  const text = await readFile(p.connection, "utf8").catch(() => null);
  const token = await readFile(p.proposeToken, "utf8").catch(() => null);
  if (text === null || token === null)
    throw new Error(
      "this machine has no proposal access; ask the hub owner to choose Allow proposals for it, then run the quench connect command it shows",
    );
  return { connection: Connection.parse(JSON.parse(text)), token: token.trim() };
}

export const HubSkill = z
  .object({ name: SkillName, path: z.string(), treeHash: TreeHash, content: z.string() })
  .strict();
export type HubSkill = z.infer<typeof HubSkill>;

async function asProposer(dir: string, path: string, init: RequestInit = {}) {
  const { connection, token } = await proposer(dir);
  return call(connection, path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });
}

export async function hubSkills(dir: string) {
  const response = await asProposer(dir, "/api/v1/skills");
  if (!response.ok) throw await failure(response, "skills refused");
  return z
    .object({
      machine: MachineName,
      skills: z.array(z.object({ name: SkillName, treeHash: TreeHash }).strict()),
    })
    .strict()
    .parse(await response.json());
}

export async function hubSkill(dir: string, name: string) {
  const response = await asProposer(dir, `/api/v1/skills/${encodeURIComponent(name)}`);
  if (!response.ok) throw await failure(response, `${name} refused`);
  return HubSkill.parse(await response.json());
}

export const ProposalReceipt = z
  .object({
    id: z.number().int().positive(),
    revision: z.string(),
    skill: SkillName,
    machine: MachineName,
    baseTreeHash: TreeHash,
    status: z.literal("pending"),
    flags: z.array(z.object({ kind: z.string(), line: z.number() }).strict()),
  })
  .strict();

export async function submitProposal(dir: string, submission: ProposalSubmission) {
  const response = await asProposer(dir, "/api/v1/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      findings?: string[];
      current?: string;
    } | null;
    const detail = [
      ...(body?.findings ?? []).map((f) => `found ${f}`),
      ...(body?.current ? [`current tree hash ${body.current}`] : []),
    ];
    throw new Error(
      `proposal refused: ${response.status} ${body?.error ?? response.statusText}${detail.length ? `\n${detail.join("\n")}` : ""}`,
    );
  }
  return ProposalReceipt.parse(await response.json());
}

export async function storedBundle(dir: string): Promise<StoredBundle | null> {
  const text = await readFile(paths(dir).bundle, "utf8").catch(() => null);
  return text ? StoredBundle.parse(JSON.parse(text)) : null;
}

export async function fetchBundle(dir: string) {
  const { connection, token } = await loadConnection(dir);
  const p = paths(dir);
  const previous = await storedBundle(dir);
  const auth = { authorization: `Bearer ${token}` };
  const response = await call(connection, "/api/v1/bundle", {
    headers: { ...auth, ...(previous ? { "if-none-match": `"${previous.id}"` } : {}) },
  });
  if (response.status === 304 && previous) return { bundle: previous, changed: false, fetched: 0 };
  if (!response.ok) throw await failure(response, "bundle refused");
  const text = await response.text();
  const id = `sha256:${sha256(text)}`;
  if (response.headers.get("etag") !== `"${id}"`)
    throw new Error("the bundle does not match its content address");
  const manifest = BundleManifest.parse(JSON.parse(text));
  if (manifest.machine !== connection.machine)
    throw new Error(`the hub sent a bundle for ${manifest.machine}, not ${connection.machine}`);
  await mkdir(p.blobs, { recursive: true });
  let fetched = 0;
  const wanted = new Set(
    Object.values(manifest.skills).flatMap((s) => s.files.map((f) => f.sha256)),
  );
  for (const digest of [...wanted].sort()) {
    const path = join(p.blobs, digest);
    const have = await readFile(path).catch(() => null);
    if (have && sha256(have) === digest) continue;
    const blob = await call(connection, `/api/v1/blobs/${digest}`, { headers: auth });
    if (!blob.ok) throw await failure(blob, `file ${digest} refused`);
    const bytes = await blob.bytes();
    if (sha256(bytes) !== digest) throw new Error(`file ${digest} does not match its hash`);
    await atomicWrite(path, bytes);
    fetched++;
  }
  const bundle = { id, manifest };
  await atomicWrite(p.bundle, `${JSON.stringify(bundle, null, 2)}\n`);
  return { bundle, changed: true, fetched };
}

export async function postSnapshot(dir: string, snapshot: Snapshot) {
  const { connection, token } = await loadConnection(dir);
  const response = await call(connection, "/api/v1/snapshot", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw await failure(response, "snapshot refused");
  return (await response.json()) as { machine: string; state: unknown };
}

async function asMachine(dir: string, path: string, init: RequestInit, what: string) {
  const { connection, token } = await loadConnection(dir);
  const response = await call(connection, path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await failure(response, what);
  return response.json() as Promise<Record<string, unknown>>;
}

export const postOtlp = (dir: string, kind: "logs" | "metrics", zstdJson: Uint8Array) =>
  asMachine(
    dir,
    `/api/v1/otlp/${kind}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: zstdJson,
    },
    `OTLP ${kind} refused`,
  );

export const postSessions = (dir: string, sessions: SessionResult[]) =>
  asMachine(
    dir,
    "/api/v1/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions }),
    },
    "session results refused",
  );

export const postTasks = (dir: string, tasks: TaskResult[]) =>
  asMachine(
    dir,
    "/api/v1/tasks",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks }),
    },
    "task results refused",
  );

export const putTranscript = (dir: string, upload: TranscriptUpload, compressed: Uint8Array) =>
  asMachine(
    dir,
    "/api/v1/transcripts",
    {
      method: "PUT",
      headers: {
        "content-type": "application/zstd",
        "x-quench-transcript": encodeURIComponent(JSON.stringify(upload)),
      },
      body: compressed,
    },
    `transcript ${upload.path} refused`,
  );

export const blobPath = (dir: string, digest: string) => join(paths(dir).blobs, digest);

async function treeAt(path: string) {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return null;
  return treeHash(await readTree(path));
}

export async function skillFolders(dir: string, manifest: BundleManifest) {
  const { trees } = paths(dir);
  await mkdir(trees, { recursive: true });
  const sources: Record<string, string> = {};
  for (const [name, skill] of Object.entries(manifest.skills)) {
    const target = join(trees, skill.treeHash.replace("sha256:", ""));
    if ((await treeAt(target)) !== skill.treeHash) {
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await mkdir(tmp);
        for (const file of skill.files) {
          const bytes = await readFile(blobPath(dir, file.sha256));
          if (sha256(bytes) !== file.sha256)
            throw new Error(`file ${file.sha256} does not match its hash`);
          const to = join(tmp, ...file.path.split("/"));
          await mkdir(dirname(to), { recursive: true });
          if (file.mode === "120000") await symlink(bytes.toString(), to);
          else
            await writeFile(to, bytes, {
              flag: "wx",
              mode: file.mode === "100755" ? 0o755 : 0o644,
            });
        }
        if ((await treeAt(tmp)) !== skill.treeHash)
          throw new Error(`${name} does not match its tree hash ${skill.treeHash}`);
        await rm(target, { recursive: true, force: true });
        await rename(tmp, target);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    sources[name] = target;
  }
  const keep = new Set(Object.values(sources).map((path) => path.slice(trees.length + 1)));
  for (const entry of await readdir(trees))
    if (!keep.has(entry)) await rm(join(trees, entry), { recursive: true, force: true });
  return sources;
}
