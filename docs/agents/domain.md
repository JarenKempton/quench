# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. **Single-context repo** (one product, no monorepo split).

## Before exploring, read these

- **`docs/`** — the canonical domain docs for Hone:
  - `docs/architecture.md` — three tiers, sources model, usage tracking, security layer
  - `docs/mvp-scope.md` — what's in/out of v1, build phases
  - `docs/decisions.md` — the settled/open decision log (this repo's ADR-equivalent; decisions are recorded here rather than in `docs/adr/`)
  - `docs/naming.md` — naming brief + kill list
  - `docs/research/` — findings from `/wayfinder` research tickets
- **`CONTEXT.md`** at the repo root — a glossary of canonical domain terms, created lazily by `/domain-modeling` when the first term is resolved. Does not exist yet.

If any of these don't exist, **proceed silently** — don't flag their absence. `/domain-modeling` (reached via `/grill-with-docs`) creates `CONTEXT.md` lazily when terms actually get resolved.

## Where decisions are recorded

This repo predates the standard `docs/adr/` layout and keeps its architectural decisions in **`docs/decisions.md`** (a "Settled" / "Open" list). When `/grill-with-docs` resolves a decision, append it there rather than creating `docs/adr/NNNN-*.md`, unless you deliberately want the fuller per-ADR format. Wayfinder decisions are additionally recorded on their GitHub ticket and indexed on the map (#1).
