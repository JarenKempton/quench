# MVP Scope

## In

1. Context x-ray per project × harness (the differentiator — nobody does pre-flight,
   cross-harness)
2. Inventory + control: skills, CLAUDE.md/AGENTS.md, MCP servers (MCP read-only in v1);
   staged changes, one Apply
3. Skill editor (Name/Description/Tags fields + body, edit/preview, version history,
   restore) — ported from command center
4. Security v1: pin-by-hash, diff-on-update, provenance, allowed-tools display, honest
   lint. Not a malware scanner.
5. Local-only default; multi-machine via git (existing state-branch sync)
6. Install rail: wrap `npx skills add`, import/emit marketplace.json, review-before-add
7. Tauri v2, tray + window

## Out (deliberately)

- OAuth/cloud/teams UI (phase 3 — git + tailnet covers ≤6 users meanwhile)
- Success-rate metrics (no honest signal), public publishing, Windows, MCP config
  editing, custom package formats

## Phases

1. **Local core** — Tauri shell, scanner, inventory, x-ray, editor, local git backing,
   matrix + staged apply (ports agentkit logic; useful with zero account)
2. **Sources + safety** — external repos, skills.sh browser, pinning, diffs, provenance,
   lint
3. **Cloud** — Workers service, OAuth, machine sync, circles, usage aggregation
4. **Ambient** — tray watchers, upstream-change notifications, packaging, easy onboarding

## Competitive context (2026-07)

Closest: xingkongliang/skills-manager (3.1k★, Tauri, skills-only — no MCP/instructions/
security/context view). skills.sh = install rail, not competitor. JFrog = enterprise
tier above. The open niche: cross-harness context control plane with provenance, for
individuals/small teams.
