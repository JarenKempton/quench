# Hone

*(working name — renameable until launch; see docs/naming.md)*

A desktop app that turns the chaos of AI agent configuration into order. See exactly
what enters each coding agent's context — skills, instruction files, MCP servers — per
project, per harness, per machine. Control it, version it, share it. You're the driver,
not the passenger.

**Not an orchestrator.** Hone never runs or commands agents. It governs what they're
equipped with.

## Principles

1. **No fake data.** Every number carries provenance: measured, configured (source
   shown), known spec, assumed (labeled), or honestly unknown.
2. **Local-first.** Fully functional with no account. Cloud adds sync/sharing, never
   becomes load-bearing.
3. **Align, don't fork.** SKILL.md per agentskills.io, AGENTS.md, marketplace.json,
   MCP registry. No invented formats; app data lives in `metadata:` or sidecars.
4. **Pinned and reviewed.** Skills pin by content hash; updates arrive as diffs you
   approve. Provenance ledger for everything. No "malware scanner" promises — pinning
   and review can't be evaded, scanners can.
5. **Hand-maintained wins.** The app helps you write and groom your own skills; the
   community registry is an install rail with review, not a firehose.

## Layout

- `docs/architecture.md` — three tiers, sources model, usage tracking, security layer
- `docs/mvp-scope.md` — what's in/out of v1, build phases
- `docs/decisions.md` — open decisions (wayfinder-style map)
- `docs/naming.md` — naming brief + kill list
- Prior art to port: `~/Documents/programming/agent-skills` (agentkit CLI + command
  center — the proven scanner/xray/apply/heartbeat logic this app absorbs)

## Stack

Tauri v2 (Rust core + webview), tray + window in one binary. Cloud (phase 3):
Cloudflare Workers + D1 + R2, GitHub OAuth.
