# Does Better Auth run on Cloudflare Workers + D1?

Resolves [#14](https://github.com/JarenKempton/hone/issues/14). Graduated from
[#10](https://github.com/JarenKempton/hone/issues/10), which chose Better Auth + GitHub/Google +
auto-link on verified email — a decision that assumed this fit and is load-bearing for the Phase 3
cloud service `docs/architecture.md:9` commits to (**Cloudflare Workers + D1 + R2**).

Sources are Better Auth's official docs, the `better-auth/better-auth` source, and Cloudflare's
official Workers/D1 docs. GitHub issues are cited only as evidence of *known problems*. Every claim
below carries a URL; claims I could not close against a primary source are tagged **UNVERIFIED** and
must not be repeated as fact.

---

## Verdict: **yes, with caveats.** No architectural change required.

The committed Workers + D1 decision holds. D1 is a first-class, natively-detected database in Better
Auth core, and the Workers runtime is a documented, supported target. Nothing in #10 needs to be
reopened.

The caveats are real but are all *implementation* constraints, not fit failures:

1. **The `better-auth` CLI cannot migrate D1** — this is documented, not a bug. Schema changes go
   through a guarded programmatic endpoint inside a Worker. (§5 — the biggest practical surprise.)
2. **Workers needs a compat flag** (`nodejs_compat` or the narrower `nodejs_als`) plus
   `compatibility_date >= 2024-09-23`. (§2)
3. **Workers is a second-class CI target** — regressions land in minor releases and are found by
   users. Pin the version; test upgrades deliberately. (§2)
4. **No interactive transactions on D1** — Better Auth uses D1's `batch()` for atomicity. (§1)
5. **`trustedProviders` weakens the verified-email gate rather than implementing it** — the exact
   inverse of what #10's wording assumes. This one deserves a second look. (§4)

---

## 1. D1 adapter — first-class, in core

**Supported natively as of Better Auth 1.5**, not via a community dialect. The
[1.5 release notes](https://better-auth.com/blog/1-5) state: *"Better Auth now natively supports
Cloudflare D1 as a first-class database option. Pass your D1 binding directly — no custom adapter
setup required."*

The dialect is first-party, living in the Better Auth monorepo at
[`packages/kysely-adapter/src/d1-sqlite-dialect.ts`](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/d1-sqlite-dialect.ts)
(`D1SqliteAdapter extends SqliteAdapter`, typed against `D1Database` from `@cloudflare/workers-types`).
It is **not** the third-party `kysely-d1`.

Selection is by duck-typing the binding —
[`packages/kysely-adapter/src/dialect.ts`](https://github.com/better-auth/better-auth/blob/main/packages/kysely-adapter/src/dialect.ts),
verified directly:

```js
if ("batch" in db && "exec" in db && "prepare" in db) {
    const { D1SqliteDialect } = await import("./d1-sqlite-dialect");
    dialect = new D1SqliteDialect({ database: db });
}
```

So `database: env.DB` is the whole integration. Dialect id resolves to `"sqlite"`, adapter id to
`"kysely"` — which matters for §5.

**Constraint:** the same release notes state *"D1 does not support interactive transactions — Better
Auth uses D1's `batch()` API for atomicity instead."* Consistent with Cloudflare's own
[D1 docs](https://developers.cloudflare.com/d1/).

### Two traps worth flagging

- **Stale doc.** [docs/adapters/other-relational-databases](https://better-auth.com/docs/adapters/other-relational-databases)
  still lists D1 under Kysely **community** dialects, pointing at `aidenwallis/kysely-d1`. This
  predates the native dialect. Outdated — do not follow it.
- **No official Cloudflare package or plugin.** `better-auth.com/docs/integrations/cloudflare` **404s**.
  `@better-auth/cloudflare` is **not published** (`registry.npmjs.org` returns `{"error":"Not found"}`),
  and `better-auth@1.6.23`'s deps contain no cloudflare entry. The `better-auth-cloudflare` package
  under [community-plugins](https://www.better-auth.com/docs/plugins/community-plugins) is
  third-party and unaffiliated (**not audited as part of this research**). D1 support is in core;
  no plugin is needed.

## 2. Workers runtime fit — supported, flagged, and historically fragile

**Runs on workerd.** Better Auth's [installation docs](https://www.better-auth.com/docs/installation)
state the requirement directly:

> "Better Auth uses AsyncLocalStorage for async context tracking. To enable this in Cloudflare
> Workers, add the `nodejs_compat` flag to your `wrangler.toml`"

```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"
```

The docs also offer a **narrower alternative** — `compatibility_flags = ["nodejs_als"]` — if only
async context tracking is needed. Cloudflare confirms this flag is real and scoped:
*"To enable only the `AsyncLocalStorage` API, use the `nodejs_als` compatibility flag."*
([compatibility-flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)).
**For Hone, `nodejs_als` is likely the right default** — smaller surface, smaller bundle — falling
back to `nodejs_compat` only if something else pulls in Node builtins.

**The date requirement is load-bearing.** Cloudflare: `nodejs_compat` *"also enables
`nodejs_compat_v2` as long as your compatibility date is 2024-09-23 or later."* Earlier dates can
opt in manually; later dates can opt out with `no_nodejs_compat_v2` to cut bundle size. Unsupported
methods fail **at runtime, not build time** — `"[unenv] <method name> is not implemented yet!"`
([runtime-apis/nodejs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)).

**Node API surface:** `AsyncLocalStorage` (per the docs above). Historically also `fs/promises` and
`path`, pulled in transitively by telemetry ([#3945](https://github.com/better-auth/better-auth/issues/3945),
which shows the errors verbatim); `Buffer` was the original blocker
([#1375](https://github.com/better-auth/better-auth/issues/1375)).

**Does the flag suffice? Not reliably — this is the honest risk.** A cluster of Workers-specific
breakages, all confirmed via `gh`:

| Issue | State | Substance |
|---|---|---|
| [#6665](https://github.com/better-auth/better-auth/issues/6665) | CLOSED | `createRequire` error on plain import **with `nodejs_compat` already on**. Fixed only in a beta. |
| [#6635](https://github.com/better-auth/better-auth/issues/6635) | — | 1.4.6 regression — SSO plugin breaks on Workers |
| [#6613](https://github.com/better-auth/better-auth/issues/6613) | CLOSED | 1.3→1.4: `No request state found... within a runWithRequestState callback` — AsyncLocalStorage context loss |
| [#8860](https://github.com/better-auth/better-auth/issues/8860) | CLOSED | **email/password sign-up exceeds the Workers CPU limit.** Pure-JS scrypt (`@noble/hashes`) sits *"right on the edge of Workers' CPU budget"*. Workaround: custom `emailAndPassword.password.hash/verify` over native `node:crypto.scryptSync`. |
| [#1143](https://github.com/better-auth/better-auth/issues/1143) | CLOSED | Bindings aren't globally accessible; the docs' module-scope `export const auth = betterAuth(...)` pattern fights the Workers env model. |

Read honestly: Workers is supported and actively fixed, but regressions ship in minor versions
(1.3.5, 1.4.6) and are caught by users rather than CI. #1143 is architectural, not a bug — the
`auth` instance must be constructed per-request (or lazily) to see `env`. **#8860 is moot for Hone
if we ship OAuth-only** (§3), since it is specific to password hashing.

**UNVERIFIED:** whether #6665's fix has reached a stable (non-beta) release — the confirmations were
on `better-auth@beta`.

## 3. Social providers on Workers — clean fit, no in-memory state

**The key question — does OAuth need a persistent process? No.** Verified at source level rather
than inferred: [`packages/better-auth/src/oauth2/state.ts`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/oauth2/state.ts)
generates the PKCE verifier and **persists it before redirect**:

```ts
const codeVerifier = generateRandomString(128);
const stateData: StateData = {
  callbackURL, codeVerifier, errorURL: c.body?.errorCallbackURL,
  link, expiresAt: Date.now() + 10 * 60 * 1000, /* ... */
};
await setOAuthState(stateData);
```

Two strategies, gated on `storeStateStrategy`:

- **Default (DB)** — `internalAdapter.createVerificationValue(...)` writes a row to the `verification`
  table, deleted after retrieval. On D1 this is one extra round-trip per callback.
- **`"cookie"`** — the state payload is encrypted into a short-lived cookie; **no DB round-trip**.

```js
betterAuth({ account: { storeStateStrategy: "cookie" } })
```

([reference/security](https://www.better-auth.com/docs/reference/security),
[errors/state_mismatch](https://www.better-auth.com/docs/reference/errors/state_mismatch))

⚠️ **Docs disagree on placement** — `account.storeStateStrategy` vs
`advanced.oauthConfig.storeStateStrategy` in canary; the source reads
`c.context.oauthConfig.storeStateStrategy`. Verify against the pinned version at implementation time.

**Either strategy works on Workers.** The DB default is the safe starting point; cookie is the
optimization.

**GitHub** ([docs/authentication/github](https://www.better-auth.com/docs/authentication/github)):
`{ clientId, clientSecret }`, callback `/api/auth/callback/github`, **`user:email` scope required**
(GitHub Apps additionally need Account Permissions → Email Addresses = Read-Only). GitHub issues no
refresh tokens. Neither the GitHub nor Google provider page says anything about Workers/edge — no
provider-side caveat found.

**Cookies** ([docs/concepts/cookies](https://www.better-auth.com/docs/concepts/cookies)): format
`${prefix}.${cookie_name}`, default prefix `better-auth`. Note *"cookies are secure only when the
server is running in production mode"* — set `useSecureCookies: true` explicitly.
`crossSubDomainCookies` takes `{ enabled, domain }`.

**Workers KV as `secondaryStorage`:** the interface
([docs/concepts/database](https://www.better-auth.com/docs/concepts/database#secondary-storage)) maps
cleanly onto KV —

```ts
interface SecondaryStorage {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
}
```

— and it stores *"session data, verification records, rate limiting counters, and other short-lived
auth data."* But the shipped examples are Redis/Upstash (`@better-auth/redis-storage`); **a Workers
KV adapter is not officially documented, and whether KV's eventual consistency is safe for the
OAuth-state/verification path is UNVERIFIED.** OAuth state is single-use and read seconds after
write, so KV's read-your-writes lag is a genuine correctness concern. **Recommendation: use D1 (the
default) or the cookie strategy; do not put OAuth state in KV without testing.**

## 4. Account linking — confirmed, but the semantics invert #10's assumption

Config lives under `account.accountLinking`
([docs/concepts/users-accounts](https://www.better-auth.com/docs/concepts/users-accounts)); keys are
`enabled`, `trustedProviders`, `disableImplicitLinking`, `allowDifferentEmails`,
`updateUserInfoOnLink`, `allowUnlinkingAll`.

**#10's premise is correct — verified email is the documented default gate:**

> "users can connect additional social sign-ons or OAuth providers to their existing accounts **if
> the provider confirms the user's email as verified**"

**But `trustedProviders` is not how you turn that on — it is how you turn it *off*.** The docs
describe it as permitting *"automatic linking even if the provider doesn't confirm the email
verification status."* Auto-link-on-verified-email is the **default behavior** once
`accountLinking.enabled` is set; listing a provider in `trustedProviders` **weakens** the guarantee
by waiving the verification check.

This matters concretely: GitHub can return unverified or private emails (hence the `user:email`
scope requirement in §3). **Putting GitHub in `trustedProviders` would open a genuine
account-takeover surface.** `disableImplicitLinking: true` hardens the other direction —
*"Same-email OAuth sign-ins for an existing user are rejected"* pending explicit user action.

➡️ **Action for #10:** its wording ("auto-link on verified email via `trustedProviders`") conflates
two opposite mechanisms. The decision's *intent* is satisfied by `accountLinking.enabled` alone,
with `trustedProviders` left **empty**. Worth a correction to the decision record.

## 5. Migrations — the CLI does not work on D1, by design

**This is the headline operational finding.** The `migrate` command gates on adapter id only —
[`packages/cli/src/commands/migrate.ts`](https://github.com/better-auth/better-auth/blob/main/packages/cli/src/commands/migrate.ts)
errors when `db.id !== "kysely"` (*"The migrate command only works with the built-in Kysely
adapter"*). D1 **is** Kysely (§1), so it clears that gate — and then fails on reachability anyway.

Verified directly against
[`docs/content/docs/concepts/database.mdx`](https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/database.mdx),
"Example: Cloudflare D1":

> "Cloudflare D1 can only be queried through a Cloudflare Worker, so the CLI cannot access it
> directly. Instead, you can run programmatic migrations through an endpoint"

The D1 binding exists only inside the Workers runtime; the Node CLI has nothing to connect to. This
is a structural property of D1, not a Better Auth gap.

**The documented path is programmatic**, from inside a Worker:

```typescript
import { getMigrations } from "better-auth/db/migration";
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
await runMigrations();
```

exposed via a temporary endpoint (`app.post("/migrate", ...)`), with the docs warning *"Protect or
remove this endpoint in production."* Docs confirm `getMigrations` *"only works with the built-in
Kysely adapter (SQLite/D1, PostgreSQL, MySQL, MSSQL)"* — D1 qualifies.

**UNVERIFIED — the `generate` → `wrangler d1 migrations apply` route.** `generate` does emit a
timestamped `.sql` file for Kysely
([`packages/cli/src/generators/kysely.ts`](https://github.com/better-auth/better-auth/blob/main/packages/cli/src/generators/kysely.ts)),
and Cloudflare's [migrations docs](https://developers.cloudflare.com/d1/reference/migrations/) state
*"Each migration is stored as an `.sql` file in your `migrations` folder"* and *"Every migration file
is an SQL file where you can specify queries to be run."* So dropping generated SQL into
`migrations/` and running `wrangler d1 migrations apply` is **plausible** — it would need the file
renamed to wrangler's `NNNN_name.sql` convention — but **no Better Auth doc describes this and I did
not test it.** If it works it is the better path (migrations in version control, no live endpoint,
normal wrangler tooling). **Recommend a spike before relying on it.**

**Naming note:** the CLI binary is `auth` / `better-auth` (package name is literally `auth`,
v1.6.23). The `npx @better-auth/cli` invocation in #14 reflects older naming.

---

## Escape hatch — not needed

#14 asked what we'd do if it didn't fit. It fits, so **no change to the committed
Workers + D1 decision is proposed.** Recorded only so the option space is on file: the alternatives
would have been Workers + Neon/Turso (keeps the runtime, restores CLI migrations, adds a vendor +
egress hop), a different auth library on D1, or a non-Workers runtime. Each is a change to a
committed architectural decision, not a free swap — and none is justified by these findings.

## Summary of what to do

| Area | Call |
|---|---|
| Database | `database: env.DB` — nothing else to wire (§1) |
| Compat flag | Start with `nodejs_als` + `compatibility_date >= 2024-09-23`; escalate to `nodejs_compat` only if needed (§2) |
| Version policy | **Pin it.** Workers regressions ship in minors; test every upgrade (§2) |
| `auth` instance | Construct per-request/lazily so it sees `env` — not module scope (§2, #1143) |
| OAuth state | Keep the D1 default; consider `storeStateStrategy: "cookie"` as an optimization. **Not KV** (§3) |
| Cookies | Set `useSecureCookies: true` explicitly (§3) |
| Account linking | `accountLinking.enabled` **with `trustedProviders` empty** — correct #10 (§4) |
| Migrations | Guarded `getMigrations` endpoint; **spike the wrangler route first** (§5) |
| Password auth | If ever added, override scrypt with `node:crypto` — pure-JS blows the CPU budget (§2, #8860) |

## Open items (do not treat as settled)

- Has [#6665](https://github.com/better-auth/better-auth/issues/6665)'s fix reached stable? (§2)
- Does `generate` → `wrangler d1 migrations apply` actually work? (§5) — **worth a spike; it is the
  materially better migration story if it does.**
- Is Workers KV safe as `secondaryStorage`? (§3) — only matters if we later want KV sessions.
- `storeStateStrategy` config placement varies across doc versions — confirm against the pinned
  version. (§3)
