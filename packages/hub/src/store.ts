import { Database } from "bun:sqlite";
import { z } from "zod";
import { Claims, EvidenceRef, MachineState, sha256 } from "@quench/fleet";

export const PAIRING_TTL_MS = 10 * 60_000;
export const ATTEMPT_WINDOW_MS = 10 * 60_000;
export const MAX_FAILED_ATTEMPTS = 10;
export const PROPOSAL_WINDOW_MS = 60 * 60_000;
export const MAX_PROPOSALS_PER_WINDOW = 10;
const SESSION_TTL_MS = 7 * 86_400_000;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const randomToken = (prefix: string) =>
  `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

export const pairingCode = () => {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b & 31]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

export const normaliseCode = (code: string) =>
  code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY, machine TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  state TEXT,
  reported_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_machine ON machines (name) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS failed_attempts (kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS propose_codes (
  code_hash TEXT PRIMARY KEY, machine_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS propose_tokens (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS proposal_submissions (machine_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  revision TEXT NOT NULL,
  skill TEXT NOT NULL,
  machine_id INTEGER NOT NULL,
  machine TEXT NOT NULL,
  base_tree_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  base_content TEXT NOT NULL,
  content TEXT NOT NULL,
  claims TEXT NOT NULL,
  evidence TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_commit TEXT
);
CREATE TRIGGER IF NOT EXISTS proposals_immutable
BEFORE UPDATE OF id, revision, skill, machine_id, machine, base_tree_hash, base_commit, base_content, content, claims, evidence, submitted_at ON proposals
BEGIN SELECT RAISE(ABORT, 'proposals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS proposals_decided_once
BEFORE UPDATE OF approved_at, approved_commit ON proposals WHEN OLD.approved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'proposal already approved'); END;
CREATE TRIGGER IF NOT EXISTS proposals_kept BEFORE DELETE ON proposals
BEGIN SELECT RAISE(ABORT, 'proposals are immutable'); END;
`;

export class SessionEnded extends Error {
  constructor() {
    super("you were signed out before this finished; sign in and try again");
  }
}

export type Identity = { id: number; name: string; tokenHash: string };

export type Proposer = { id: number; machineId: number; name: string; tokenHash: string };

export type Scope = "machine" | "propose";

const ProposalRow = z.object({
  id: z.number(),
  revision: z.string(),
  skill: z.string(),
  machine: z.string(),
  base_tree_hash: z.string(),
  base_commit: z.string(),
  base_content: z.string(),
  content: z.string(),
  claims: z.string().transform((c) => Claims.parse(JSON.parse(c))),
  evidence: z.string().transform((e) => z.array(EvidenceRef).parse(JSON.parse(e))),
  submitted_at: z.number(),
  approved_at: z.number().nullable(),
  approved_commit: z.string().nullable(),
});
export type StoredProposal = z.infer<typeof ProposalRow>;

export type NewProposal = Pick<
  StoredProposal,
  "revision" | "skill" | "base_tree_hash" | "base_commit" | "base_content" | "content"
> & { claims: z.infer<typeof Claims>; evidence: z.infer<typeof EvidenceRef>[] };

export type MachineRow = {
  id: number;
  name: string;
  paired_at: number;
  last_seen_at: number | null;
  state: string | null;
  reported_at: number | null;
  proposals: number;
};

export class Store {
  readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  hasOwner() {
    return !!this.db.query("SELECT 1 FROM owner").get();
  }

  async setOwner(password: string) {
    const hash = await Bun.password.hash(password);
    this.db.query("INSERT INTO owner (id, password_hash) VALUES (1, ?)").run(hash);
  }

  async checkOwner(password: string) {
    const row = this.db.query("SELECT password_hash FROM owner").get() as {
      password_hash: string;
    } | null;
    return !!row && (await Bun.password.verify(password, row.password_hash));
  }

  newSession() {
    const token = randomToken("qs_");
    this.db
      .query("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(sha256(token), this.now() + SESSION_TTL_MS);
    return token;
  }

  validSession(token: string | undefined) {
    if (!token) return false;
    return !!this.db
      .query("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(sha256(token), this.now());
  }

  asOwner<T>(session: string, check: () => boolean, action: () => T): T {
    return this.db
      .transaction(() => {
        if (!this.validSession(session) || !check()) throw new SessionEnded();
        return action();
      })
      .immediate();
  }

  endSession(token: string | undefined) {
    if (token) this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  attempt(kind: string): number | null {
    return this.db
      .transaction(() => {
        this.db
          .query("DELETE FROM failed_attempts WHERE at <= ?")
          .run(this.now() - ATTEMPT_WINDOW_MS);
        const { n } = this.db
          .query("SELECT COUNT(*) AS n FROM failed_attempts WHERE kind = ?")
          .get(kind) as { n: number };
        if (n >= MAX_FAILED_ATTEMPTS) return null;
        return Number(
          this.db
            .query("INSERT INTO failed_attempts (kind, at) VALUES (?, ?)")
            .run(kind, this.now()).lastInsertRowid,
        );
      })
      .immediate();
  }

  succeeded(attempt: number) {
    this.db.query("DELETE FROM failed_attempts WHERE rowid = ?").run(attempt);
  }

  activeMachine(name: string) {
    return !!this.db
      .query("SELECT 1 FROM machines WHERE name = ? AND revoked_at IS NULL")
      .get(name);
  }

  newPairingCode(machine: string) {
    const code = pairingCode();
    this.db
      .query("INSERT INTO pairing_codes (code_hash, machine, expires_at) VALUES (?, ?, ?)")
      .run(sha256(normaliseCode(code)), machine, this.now() + PAIRING_TTL_MS);
    return code;
  }

  redeem(code: string): { machine: string; token: string; scope: Scope } | null {
    const hash = sha256(normaliseCode(code));
    return this.db.transaction(() => {
      const row = this.db
        .query(
          "UPDATE pairing_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING machine, expires_at",
        )
        .get(this.now(), hash) as { machine: string; expires_at: number } | null;
      if (!row) return this.redeemPropose(hash);
      if (this.activeMachine(row.machine)) return null;
      const revokedSince = this.db
        .query("SELECT 1 FROM machines WHERE name = ? AND revoked_at > ?")
        .get(row.machine, row.expires_at - PAIRING_TTL_MS);
      if (revokedSince) return null;
      const token = randomToken("qm_");
      this.db
        .query("INSERT INTO machines (name, token_hash, paired_at) VALUES (?, ?, ?)")
        .run(row.machine, sha256(token), this.now());
      return { machine: row.machine, token, scope: "machine" as const };
    })();
  }

  private redeemPropose(hash: string) {
    const row = this.db
      .query(
        "UPDATE propose_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING machine_id",
      )
      .get(this.now(), hash) as { machine_id: number } | null;
    const machine =
      row &&
      (this.db
        .query("SELECT id, name FROM machines WHERE id = ? AND revoked_at IS NULL")
        .get(row.machine_id) as { id: number; name: string } | null);
    if (!machine) return null;
    this.db
      .query("UPDATE propose_tokens SET revoked_at = ? WHERE machine_id = ? AND revoked_at IS NULL")
      .run(this.now(), machine.id);
    const token = randomToken("qp_");
    this.db
      .query("INSERT INTO propose_tokens (machine_id, token_hash, issued_at) VALUES (?, ?, ?)")
      .run(machine.id, sha256(token), this.now());
    return { machine: machine.name, token, scope: "propose" as const };
  }

  newProposeCode(name: string) {
    const machine = this.db
      .query("SELECT id FROM machines WHERE name = ? AND revoked_at IS NULL")
      .get(name) as { id: number } | null;
    if (!machine) return null;
    const code = pairingCode();
    this.db
      .query("INSERT INTO propose_codes (code_hash, machine_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256(normaliseCode(code)), machine.id, this.now() + PAIRING_TTL_MS);
    return code;
  }

  revokeProposals(name: string) {
    return this.db.transaction(() => {
      const ids = this.db.query("SELECT id FROM machines WHERE name = ?").all(name) as {
        id: number;
      }[];
      let changes = 0;
      for (const { id } of ids) {
        changes += this.db
          .query("UPDATE propose_codes SET used_at = ? WHERE machine_id = ? AND used_at IS NULL")
          .run(this.now(), id).changes;
        changes += this.db
          .query(
            "UPDATE propose_tokens SET revoked_at = ? WHERE machine_id = ? AND revoked_at IS NULL",
          )
          .run(this.now(), id).changes;
      }
      return changes > 0;
    })();
  }

  proposerFor(token: string | null): Proposer | null {
    if (!token?.startsWith("qp_")) return null;
    const tokenHash = sha256(token);
    const row = this.db
      .query(
        "SELECT p.id, p.machine_id, m.name FROM propose_tokens p JOIN machines m ON m.id = p.machine_id WHERE p.token_hash = ? AND p.revoked_at IS NULL AND m.revoked_at IS NULL",
      )
      .get(tokenHash) as { id: number; machine_id: number; name: string } | null;
    return row && { id: row.id, machineId: row.machine_id, name: row.name, tokenHash };
  }

  proposerActive(proposer: Proposer) {
    return !!this.db
      .query(
        "SELECT 1 FROM propose_tokens p JOIN machines m ON m.id = p.machine_id WHERE p.id = ? AND p.token_hash = ? AND p.revoked_at IS NULL AND m.id = ? AND m.revoked_at IS NULL",
      )
      .get(proposer.id, proposer.tokenHash, proposer.machineId);
  }

  submission(proposer: Proposer) {
    return this.db
      .transaction(() => {
        this.db
          .query("DELETE FROM proposal_submissions WHERE at <= ?")
          .run(this.now() - PROPOSAL_WINDOW_MS);
        const { n } = this.db
          .query("SELECT COUNT(*) AS n FROM proposal_submissions WHERE machine_id = ?")
          .get(proposer.machineId) as { n: number };
        if (n >= MAX_PROPOSALS_PER_WINDOW) return false;
        this.db
          .query("INSERT INTO proposal_submissions (machine_id, at) VALUES (?, ?)")
          .run(proposer.machineId, this.now());
        return true;
      })
      .immediate();
  }

  addProposal(proposer: Proposer, p: NewProposal): number | null {
    return this.db
      .transaction(() => {
        if (!this.proposerActive(proposer)) return null;
        const same = this.db
          .query(
            "SELECT id FROM proposals WHERE machine_id = ? AND skill = ? AND revision = ? AND base_tree_hash = ? AND approved_at IS NULL",
          )
          .get(proposer.machineId, p.skill, p.revision, p.base_tree_hash) as { id: number } | null;
        if (same) return same.id;
        return Number(
          this.db
            .query(
              "INSERT INTO proposals (revision, skill, machine_id, machine, base_tree_hash, base_commit, base_content, content, claims, evidence, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              p.revision,
              p.skill,
              proposer.machineId,
              proposer.name,
              p.base_tree_hash,
              p.base_commit,
              p.base_content,
              p.content,
              JSON.stringify(p.claims),
              JSON.stringify(p.evidence),
              this.now(),
            ).lastInsertRowid,
        );
      })
      .immediate();
  }

  proposal(id: number): StoredProposal | null {
    const row = this.db.query("SELECT * FROM proposals WHERE id = ?").get(id);
    return row ? ProposalRow.parse(row) : null;
  }

  proposals(limit = 50): StoredProposal[] {
    return this.db
      .query("SELECT * FROM proposals ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => ProposalRow.parse(row));
  }

  approved(id: number, commit: string) {
    this.db
      .query(
        "UPDATE proposals SET approved_at = ?, approved_commit = ? WHERE id = ? AND approved_at IS NULL",
      )
      .run(this.now(), commit, id);
  }

  machineFor(token: string | null): Identity | null {
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = this.db
      .query("SELECT id, name FROM machines WHERE token_hash = ? AND revoked_at IS NULL")
      .get(tokenHash) as { id: number; name: string } | null;
    if (!row) return null;
    this.db.query("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(this.now(), row.id);
    return { id: row.id, name: row.name, tokenHash };
  }

  stillActive(identity: Identity) {
    return !!this.db
      .query("SELECT 1 FROM machines WHERE id = ? AND token_hash = ? AND revoked_at IS NULL")
      .get(identity.id, identity.tokenHash);
  }

  revoke(name: string) {
    return this.db.transaction(() => {
      const codes = this.db
        .query("UPDATE pairing_codes SET used_at = ? WHERE machine = ? AND used_at IS NULL")
        .run(this.now(), name).changes;
      const proposals = this.revokeProposals(name);
      const machines = this.db
        .query("UPDATE machines SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
        .run(this.now(), name).changes;
      return codes + machines > 0 || proposals;
    })();
  }

  machines(): MachineRow[] {
    return this.db
      .query(
        "SELECT id, name, paired_at, last_seen_at, state, reported_at, (SELECT COUNT(*) FROM propose_tokens p WHERE p.machine_id = machines.id AND p.revoked_at IS NULL) AS proposals FROM machines WHERE revoked_at IS NULL ORDER BY name",
      )
      .all() as MachineRow[];
  }

  machineState(name: string): MachineState | null {
    const row = this.db
      .query("SELECT state FROM machines WHERE name = ? AND revoked_at IS NULL")
      .get(name) as { state: string | null } | null;
    return row?.state ? MachineState.parse(JSON.parse(row.state)) : null;
  }

  report(identity: Identity, apply: (previous: MachineState | null) => MachineState) {
    return this.db
      .transaction(() => {
        const row = this.db
          .query(
            "SELECT state FROM machines WHERE id = ? AND token_hash = ? AND revoked_at IS NULL",
          )
          .get(identity.id, identity.tokenHash) as { state: string | null } | null;
        if (!row) return null;
        const next = apply(row.state ? MachineState.parse(JSON.parse(row.state)) : null);
        this.db
          .query("UPDATE machines SET state = ?, reported_at = ? WHERE id = ?")
          .run(JSON.stringify(next), this.now(), identity.id);
        return next;
      })
      .immediate();
  }
}
