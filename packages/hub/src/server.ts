import { timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { z } from "zod";
import {
  excluded,
  FleetFile,
  MachineName,
  MAX_PROPOSAL_BYTES,
  own,
  ProposalSubmission,
  RelativePath,
  sha256,
  SkillName,
  Snapshot,
} from "@quench/fleet";
import { detect, detectInFile } from "@quench/secrets";
import { FLEET_FILE } from "@quench/fleet/disk";
import { selfSignedCertificate, spkiPin } from "./cert.ts";
import { GitError, StaleHead } from "./git.ts";
import type { DataDir } from "./data.ts";
import { Hub, SHIPPED_SKILL } from "./hub.ts";
import { isLoopback } from "./loopback.ts";
import { binary, flagsFor } from "./review.ts";
import { SessionEnded, type Identity, type Proposer, type StoredProposal } from "./store.ts";
import {
  connectPage,
  dashboard,
  editPage,
  loginPage,
  messagePage,
  proposalPage,
  type ProposalSummary,
} from "./ui.ts";

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_FORM_BYTES = 1024 * 1024;
const MAX_PAIR_BYTES = 4096;
const MAX_PROPOSAL_BODY = MAX_PROPOSAL_BYTES * 6 + 16 * 1024;
const COOKIE = "quench_hub";

export type ServeOptions = {
  dataDir: string;
  hostname: string;
  port: number;
  http?: boolean;
  tls?: { cert: string; key: string };
  url?: string;
  mirror?: string;
  password?: string;
  now?: () => number;
  log?: (line: string) => void;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body)
    for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > max) return null;
      chunks.push(chunk);
    }
  return Buffer.concat(chunks);
}

const parseJson = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};

const revoked = () => json({ error: "unknown or revoked machine token" }, 401);

const tooLarge = () => json({ error: "body too large" }, 413);

const bearer = (req: Request) =>
  /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

const cookie = (req: Request) =>
  (req.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1];

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location: to, ...headers } });

async function certificate(data: DataDir, names: string[]) {
  const existing = await data.read(["tls", "cert.pem"]);
  const key = await data.read(["tls", "key.pem"]);
  if (existing && key) return { cert: existing.toString("utf8"), key: key.toString("utf8") };
  const made = selfSignedCertificate(names);
  await data.remove("tls");
  await data.write(["tls", "key.pem"], made.key, 0o600);
  await data.write(["tls", "cert.pem"], made.cert, 0o644);
  return made;
}

const certificateNames = (options: ServeOptions) => {
  const names = ["localhost", "127.0.0.1", "::1", hostname()];
  if (options.hostname && !["0.0.0.0", "::"].includes(options.hostname))
    names.push(options.hostname);
  if (options.url) names.push(new URL(options.url).hostname.replace(/^\[|\]$/g, ""));
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (!i.internal) names.push(i.address.split("%")[0]!);
  return names;
};

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const commitField = (f: URLSearchParams | null, name: string) => {
  const value = f?.get(name) ?? "";
  return COMMIT.test(value) ? value : null;
};

const ROUTES: Record<string, string[]> = {
  "/": ["GET"],
  "/login": ["POST"],
  "/logout": ["POST"],
  "/machines": ["POST"],
  "/machines/revoke": ["POST"],
  "/toggle": ["POST"],
  "/revert": ["POST"],
  "/edit": ["GET", "POST"],
  "/machines/propose": ["POST"],
  "/machines/propose/revoke": ["POST"],
  "/skills/shipped": ["POST"],
  "/proposal": ["GET"],
  "/proposal/approve": ["POST"],
};

const csrfToken = (session: string) => sha256(`csrf\0${session}`);

const sameToken = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

async function withCsrf(response: Response, token: string) {
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  const html = (await response.text()).replace(
    /<form method="post"[^>]*>/g,
    (tag) => `${tag}<input type="hidden" name="csrf" value="${token}">`,
  );
  return new Response(html, { status: response.status, headers: response.headers });
}

type Owned = { now: <T>(action: () => T) => T; guard: () => void };

const PairRequest = z.object({ code: z.string().min(1).max(64) }).strict();

export async function serveHub(options: ServeOptions) {
  if (options.http && !isLoopback(options.hostname))
    throw new Error("plain HTTP is only allowed on a loopback address such as 127.0.0.1");
  if (
    options.url &&
    new URL(options.url).protocol === "http:" &&
    !isLoopback(new URL(options.url).hostname)
  )
    throw new Error("an http:// hub URL must be a loopback address");
  const hub = await Hub.open(options.dataDir, {
    ...(options.mirror ? { mirror: options.mirror } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  try {
    if (!hub.store.hasOwner()) {
      if (!options.password || options.password.length < 8)
        throw new Error(
          "first run: set QUENCH_HUB_PASSWORD to the owner password (8 characters or more)",
        );
      await hub.store.setOwner(options.password);
    }
  } catch (error) {
    hub.close();
    throw error;
  }
  const generated = !options.http && !options.tls;
  const tls = options.http
    ? undefined
    : (options.tls ?? (await certificate(hub.data, certificateNames(options))));
  const pin = generated && tls ? spkiPin(tls.cert) : null;
  if (options.mirror) hub.mirror();

  const owner = (req: Request) => hub.store.validSession(cookie(req));
  const sameOrigin = (req: Request) => {
    const origin = req.headers.get("origin");
    return (
      origin !== null &&
      (origin === new URL(req.url).origin ||
        (!!options.url && origin === new URL(options.url).origin))
    );
  };
  const form = async (req: Request) => {
    const body = await readCapped(req, MAX_FORM_BYTES);
    return body && new URLSearchParams(new TextDecoder().decode(body));
  };
  const publicUrl = (req: Request) => (options.url ?? new URL(req.url).origin).replace(/\/+$/, "");
  const secure = tls ? "; Secure" : "";

  const ended = (error: unknown) => {
    if (error instanceof SessionEnded) return messagePage("Signed out", error.message, 401);
    throw error;
  };

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => {
    const run = queue.then(action, action);
    queue = run.catch(() => undefined);
    return run;
  };

  const conflict = (error: unknown) => {
    if (error instanceof SessionEnded) return ended(error);
    if (error instanceof StaleHead) return messagePage("Stale page", error.message, 409);
    if (error instanceof GitError || error instanceof z.ZodError || error instanceof Error)
      return messagePage("Not saved", error.message, 400);
    throw error;
  };

  async function api(req: Request, path: string): Promise<Response> {
    if (path === "/api/v1/pair" && req.method === "POST") {
      const attempt = hub.store.attempt("pair");
      if (attempt === null) return json({ error: "too many attempts; wait and retry" }, 429);
      const body = await readCapped(req, MAX_PAIR_BYTES);
      if (!body) return tooLarge();
      const parsed = PairRequest.safeParse(parseJson(body));
      const paired = parsed.success ? hub.store.redeem(parsed.data.code) : null;
      if (!paired) return json({ error: "invalid, used or expired code" }, 401);
      hub.store.succeeded(attempt);
      return json({ machine: paired.machine, token: paired.token, scope: paired.scope });
    }
    if (
      path === "/api/v1/skills" ||
      path.startsWith("/api/v1/skills/") ||
      path === "/api/v1/proposals"
    ) {
      const proposer = hub.store.proposerFor(bearer(req));
      if (!proposer) return revoked();
      const response = await proposeRoute(req, path, proposer);
      return hub.store.proposerActive(proposer) ? response : revoked();
    }
    const identity = hub.store.machineFor(bearer(req));
    if (!identity) return revoked();
    const response = await machineRoute(req, path, identity);
    return hub.store.stillActive(identity) ? response : revoked();
  }

  async function machineRoute(req: Request, path: string, identity: Identity): Promise<Response> {
    const machine = identity.name;
    if (path === "/api/v1/bundle" && req.method === "GET") {
      const bundle = await hub.bundle(machine, await hub.head());
      const etag = `"${bundle.id}"`;
      if (req.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return new Response(bundle.json, {
        headers: { "content-type": "application/json", etag, "cache-control": "no-store" },
      });
    }
    const blob = /^\/api\/v1\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (blob && req.method === "GET") {
      const bytes = await hub.blob(machine, blob[1]!);
      if (!bytes) return json({ error: "not in this machine's bundle" }, 404);
      return new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      });
    }
    if (path === "/api/v1/snapshot" && req.method === "POST") {
      const body = await readCapped(req, MAX_SNAPSHOT_BYTES);
      if (!body) return tooLarge();
      const parsed = Snapshot.safeParse(parseJson(body));
      if (!parsed.success)
        return json({ error: "invalid snapshot", issues: parsed.error.issues }, 400);
      const state = hub.report(identity, parsed.data);
      if (!state) return revoked();
      return json({ machine, state });
    }
    return json({ error: "not found" }, 404);
  }

  async function proposeRoute(req: Request, path: string, proposer: Proposer): Promise<Response> {
    const machine = proposer.name;
    if (path === "/api/v1/skills" && req.method === "GET")
      return json({ machine, skills: await hub.assignedSkills(machine, await hub.head()) });
    const one = /^\/api\/v1\/skills\/([^/]+)$/.exec(path);
    if (one && req.method === "GET") {
      const name = SkillName.safeParse(decodeURIComponent(one[1]!));
      const skill = name.success && (await hub.assignedSkill(machine, await hub.head(), name.data));
      if (!skill) return json({ error: "not a skill assigned to this machine" }, 404);
      return json(skill);
    }
    if (path === "/api/v1/proposals" && req.method === "POST") return propose(req, proposer);
    return json({ error: "not found" }, 404);
  }

  async function propose(req: Request, proposer: Proposer): Promise<Response> {
    if (!hub.store.submission(proposer))
      return json({ error: "too many proposals from this machine; wait an hour and retry" }, 429);
    const body = await readCapped(req, MAX_PROPOSAL_BODY);
    if (!body) return tooLarge();
    const raw = parseJson(body) as { content?: unknown } | undefined;
    if (typeof raw?.content === "string" && Buffer.byteLength(raw.content) > MAX_PROPOSAL_BYTES)
      return json({ error: `proposal content is over ${MAX_PROPOSAL_BYTES} bytes` }, 413);
    const parsed = ProposalSubmission.safeParse(raw);
    if (!parsed.success)
      return json({ error: "invalid proposal", issues: parsed.error.issues }, 400);
    const submission = parsed.data;
    if (binary(submission.content))
      return json(
        { error: "binary content is refused; a proposal is one plain-text SKILL.md" },
        415,
      );
    const findings = [
      ...detectInFile(submission.content, "SKILL.md"),
      ...detect(JSON.stringify([submission.claims, submission.evidence])),
    ];
    if (findings.length)
      return json(
        {
          error: "the secret scan flagged this proposal; nothing was stored",
          findings: [...new Set(findings.map((f) => `${f.provider} (${f.rule})`))].sort(),
        },
        422,
      );
    const head = await hub.head();
    const skill = await hub.assignedSkill(proposer.name, head, submission.skill);
    if (!skill) return json({ error: "not a skill assigned to this machine" }, 404);
    if (skill.treeHash !== submission.baseTreeHash)
      return json(
        {
          error: "the base is out of date; run quench skill show again and redo the edit",
          current: skill.treeHash,
        },
        409,
      );
    if (skill.content === submission.content)
      return json({ error: "the proposal is the same as the current SKILL.md" }, 400);
    const revision = sha256(submission.content);
    const id = hub.store.addProposal(proposer, {
      revision,
      skill: skill.name,
      base_tree_hash: skill.treeHash,
      base_commit: head,
      base_content: skill.content,
      content: submission.content,
      claims: submission.claims,
      evidence: submission.evidence,
    });
    if (id === null) return revoked();
    return json(
      {
        id,
        revision,
        skill: skill.name,
        machine: proposer.name,
        baseTreeHash: skill.treeHash,
        status: "pending",
        flags: flagsFor(skill.content, submission.content).map(({ kind, line }) => ({
          kind,
          line,
        })),
      },
      201,
    );
  }

  async function review(
    p: StoredProposal,
    head: string,
    extra: { error?: string; status?: number } = {},
  ) {
    const current = await hub.skillAt(head, p.skill);
    const stale = !current || current.treeHash !== p.base_tree_hash;
    return proposalPage({
      proposal: p,
      head,
      current,
      diff: await hub.repo.diff(p.base_content, p.content, `${current?.path ?? p.skill}/SKILL.md`),
      flags: flagsFor(p.base_content, p.content),
      threeWay:
        stale && current && !p.approved_at
          ? await hub.repo.threeWay(current.content, p.base_content, p.content)
          : null,
      ...extra,
    });
  }

  async function summaries(head: string): Promise<ProposalSummary[]> {
    const hashes = new Map<string, Promise<string | null>>();
    const hashOf = (skill: string) => {
      if (!hashes.has(skill))
        hashes.set(
          skill,
          hub.skillAt(head, skill).then((s) => s?.treeHash ?? null),
        );
      return hashes.get(skill)!;
    };
    return Promise.all(
      hub.store.proposals().map(async (p) => ({
        id: p.id,
        skill: p.skill,
        machine: p.machine,
        submitted_at: p.submitted_at,
        approved_at: p.approved_at,
        approved_commit: p.approved_commit,
        stale: !p.approved_at && (await hashOf(p.skill)) !== p.base_tree_hash,
      })),
    );
  }

  async function approve(f: URLSearchParams, as: Owned): Promise<Response> {
    const id = Number(f.get("id"));
    const base = commitField(f, "base");
    if (!Number.isSafeInteger(id) || !base) return messagePage("Not approved", "bad proposal", 400);
    const attempt = as.now(() => hub.store.attempt("approve"));
    if (attempt === null)
      return messagePage("Not approved", "too many attempts; wait and retry", 429);
    if (!(await hub.store.checkOwner(f.get("password") ?? "")))
      return messagePage("Not approved", "wrong password; nothing was committed", 401);
    hub.store.succeeded(attempt);
    const p = hub.store.proposal(id);
    if (!p) return messagePage("Not found", "no such proposal", 404);
    if (p.approved_at) return messagePage("Not approved", "this proposal is already approved", 409);
    const current = await hub.skillAt(base, p.skill);
    if (!current || current.treeHash !== p.base_tree_hash)
      return review(p, await hub.head(), {
        error: "this proposal is stale; nothing was committed",
        status: 409,
      });
    try {
      const commit = await hub.writeFile(
        base,
        `${current.path}/SKILL.md`,
        p.content,
        `Approve proposal ${id} to ${p.skill} from ${p.machine}`,
        () => {
          as.guard();
          if (hub.store.proposal(id)?.approved_at) throw new Error("already approved");
        },
      );
      hub.store.approved(id, commit);
      return redirect(`/proposal?id=${id}`);
    } catch (error) {
      return conflict(error);
    }
  }

  async function ui(req: Request, path: string): Promise<Response> {
    const allowed = ROUTES[path];
    if (!allowed) return messagePage("Not found", "no such page", 404);
    if (!allowed.includes(req.method))
      return messagePage("Method not allowed", `${path} accepts ${allowed.join(", ")}`, 405, {
        allow: allowed.join(", "),
      });
    if (req.method !== "GET" && !sameOrigin(req))
      return messagePage("Refused", "cross-origin form submissions are refused", 403);
    if (path === "/login") {
      const attempt = hub.store.attempt("login");
      if (attempt === null) return loginPage("Too many attempts; wait and retry.", 429);
      const fields = await form(req);
      if (!fields || !(await hub.store.checkOwner(fields.get("password") ?? "")))
        return loginPage("Wrong password.", 401);
      hub.store.succeeded(attempt);
      return redirect("/", {
        "set-cookie": `${COOKIE}=${hub.store.newSession()}; Path=/; HttpOnly; SameSite=Strict${secure}`,
      });
    }
    const fields = req.method === "POST" ? await form(req) : new URL(req.url).searchParams;
    if (!fields) return messagePage("Not saved", "body too large", 413);
    const session = cookie(req);
    if (!session || !owner(req))
      return req.method === "GET" ? loginPage() : ended(new SessionEnded());
    const token = csrfToken(session);
    const respond = (response: Response) =>
      path !== "/logout" && !hub.store.validSession(session)
        ? ended(new SessionEnded())
        : withCsrf(response, token);
    if (req.method === "GET") return respond(await owned(req, path, fields, null).catch(ended));
    const tokenOk = () => sameToken(fields.get("csrf") ?? "", token);
    if (!tokenOk())
      return messagePage("Refused", "this form is missing its session token; reload the page", 403);
    const as: Owned = {
      now: (action) => hub.store.asOwner(session, tokenOk, action),
      guard: () => hub.store.asOwner(session, tokenOk, () => undefined),
    };
    return serial(async () => {
      as.guard();
      return respond(await owned(req, path, fields, as));
    }).catch(ended);
  }

  async function owned(
    req: Request,
    path: string,
    f: URLSearchParams,
    as: Owned | null,
  ): Promise<Response> {
    if (as && path === "/logout") {
      as.now(() => hub.store.endSession(cookie(req)));
      return redirect("/", {
        "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
      });
    }
    if (path === "/") {
      const head = await hub.head();
      const { fleet, warnings } = await hub.fleetAt(head);
      return dashboard({
        head,
        fleet,
        warnings,
        machines: hub.store
          .machines()
          .map((m) => ({ ...m, state: hub.store.machineState(m.name) })),
        history: await hub.repo.log(20),
        files: await hub.repo.files(head),
        proposals: await summaries(head),
        shipped: own(fleet.skills, SHIPPED_SKILL.name) ? null : SHIPPED_SKILL.name,
      });
    }
    if (path === "/proposal") {
      const id = Number(f.get("id"));
      const p = Number.isSafeInteger(id) ? hub.store.proposal(id) : null;
      if (!p) return messagePage("Not found", "no such proposal", 404);
      return review(p, await hub.head());
    }
    if (path === "/proposal/approve") return approve(f, as!);
    if (path === "/machines/propose") {
      const name = MachineName.safeParse(f.get("name"));
      const code = name.success ? as!.now(() => hub.store.newProposeCode(name.data)) : null;
      if (!name.success || !code)
        return messagePage("Not allowed", "proposals need a paired machine", 409);
      return connectPage(
        name.data,
        `quench connect ${publicUrl(req)} --code ${code}${pin ? ` --pin ${pin}` : ""}`,
        true,
      );
    }
    if (path === "/machines/propose/revoke") {
      as!.now(() => hub.store.revokeProposals(f.get("name") ?? ""));
      return redirect("/");
    }
    if (path === "/skills/shipped") {
      const base = commitField(f, "base");
      if (!base) return messagePage("Not added", "bad base commit", 400);
      return hub.addShippedSkill(base, as!.guard).then(() => redirect("/"), conflict);
    }
    if (path === "/machines") {
      const name = MachineName.safeParse(f.get("name"));
      if (!name.success)
        return messagePage("Not added", "machine names are lowercase letters, digits, . _ -", 400);
      const code = as!.now(() =>
        hub.store.activeMachine(name.data) ? null : hub.store.newPairingCode(name.data),
      );
      if (!code)
        return messagePage("Not added", `${name.data} is already paired; revoke it first`, 409);
      return connectPage(
        name.data,
        `quench connect ${publicUrl(req)} --code ${code}${pin ? ` --pin ${pin}` : ""}`,
      );
    }
    if (path === "/machines/revoke") {
      as!.now(() => hub.store.revoke(f.get("name") ?? ""));
      return redirect("/");
    }
    if (path === "/toggle") {
      const machine = MachineName.safeParse(f.get("machine"));
      const base = commitField(f, "base");
      if (!machine.success || !base) return messagePage("Not saved", "bad toggle", 400);
      return hub
        .toggle(base, f.get("skill") ?? "", machine.data, f.get("on") === "1", as!.guard)
        .then(() => redirect("/"), conflict);
    }
    if (path === "/revert") {
      const commit = commitField(f, "commit");
      const base = commitField(f, "base");
      if (!commit || !base) return messagePage("Not reverted", "bad commit", 400);
      return hub.revert(base, commit, as!.guard).then(() => redirect("/"), conflict);
    }
    return edit(req, f, as);
  }

  async function edit(req: Request, f: URLSearchParams, as: Owned | null) {
    const path = f.get("path") ?? "";
    if (!RelativePath.safeParse(path).success || excluded(path))
      return messagePage("Not found", "that path cannot be edited", 400);
    if (req.method === "GET") {
      const base = await hub.head();
      return editPage({ path, base, content: (await hub.repo.show(base, path)) ?? "" });
    }
    const base = commitField(f, "base");
    if (!base) return messagePage("Not saved", "bad base commit", 400);
    const before = await hub.repo.show(base, path);
    const typed = f.get("content") ?? "";
    const content = before?.includes("\r") ? typed : typed.replace(/\r\n/g, "\n");
    const fields = { path, base, content };
    let error: string | undefined;
    if (path === FLEET_FILE)
      try {
        FleetFile.parse(Bun.YAML.parse(content));
      } catch (e) {
        error = `not a valid fleet file: ${(e as Error).message}`;
      }
    const diff = await hub.repo.diff(before, content, path);
    const previewed = f.get("previewed");
    if (f.get("action") !== "save" || error || previewed !== sha256(content) || !diff)
      return editPage({ ...fields, diff, previewed: sha256(content), ...(error ? { error } : {}) });
    return hub
      .writeFile(base, path, content, `Edit ${path}`, as!.guard)
      .then(() => redirect("/"), conflict);
  }

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: 2 * MAX_SNAPSHOT_BYTES,
    ...(tls ? { tls } : {}),
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try {
        return await (path.startsWith("/api/") ? api(req, path) : ui(req, path));
      } catch (error) {
        options.log?.(`error on ${req.method} ${path}: ${(error as Error).message}`);
        return path.startsWith("/api/")
          ? json({ error: "internal error" }, 500)
          : messagePage("Error", "something went wrong", 500);
      }
    },
  });
  const host = server.hostname?.includes(":") ? `[${server.hostname}]` : server.hostname;
  return {
    hub,
    server,
    pin,
    url: `${tls ? "https" : "http"}://${host}:${server.port}`,
    cert: tls?.cert ?? null,
    async stop() {
      await server.stop(true);
      await hub.mirrored();
      await hub.repo.settled();
      hub.close();
    },
  };
}
