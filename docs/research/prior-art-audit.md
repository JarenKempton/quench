# Prior-art audit: agent-skills scanner / x-ray / apply surface

Audit of `~/Documents/programming/agent-skills` to size a port to a Tauri v2
(Rust + webview) desktop app. Two Python programs, stdlib-only:

- `scripts/agentkit` (~400 lines) — CLI core lib: catalog, manifests, usage, project view, converge/heartbeat/daemon.
- `scripts/command_center.py` (~1463 lines) — `127.0.0.1` `http.server` web app. First ~556 lines are backend logic; the rest is a single inlined HTML/CSS/JS SPA (`PAGE`). Imports `agentkit` as a module (`ak`).

The whole thing is a **lens over git + the filesystem**. Git is the control plane; there is no database.

---

## 1. Scanner — harness & skill discovery

### Harnesses (hard-coded)
`agentkit.HOSTS` = symlink-based hosts only:
- `claude-global` → `~/.claude/skills`
- `hermes-default` → `~/.hermes/skills`

Other harnesses are handled ad hoc elsewhere (not symlink hosts):
- **Codex** — `~/.codex/AGENTS.md`, `~/.codex/config.toml`. No skill loader ("skills NOT exported to Codex today"); only the AGENTS.md chain loads.
- **Pi** — package install at `~/.pi/agent/git/github.com/JarenKempton/agent-skills` (loads `skills/` wholesale). Config at `~/.pi/agent/settings.json`.
- **Hermes** — `~/.hermes/skills`, only linked if `~/.hermes` exists.

`MACHINE = platform.node().split(".")[0].lower()` keys per-machine overrides & fleet.

### Skill catalog — `agentkit.catalog()`
- **Active** skills: `(REPO/"skills").glob("*/*")` — fixed depth `skills/<category>/<skill>`, requires `SKILL.md`. `glob` (not `rglob`) deliberately, so dir symlinks are followed. `vendored = sd.is_symlink()`.
- **Bench** skills: `(REPO/"vendor").rglob("SKILL.md")` not already seen via a symlink; keyed `<name>` or `<name>-upstream` on collision; `status="bench"`.
- `frontmatter()` parses `SKILL.md` YAML front-matter by regex (no yaml dep): `name`, `description`, `disable-model-invocation` (→ `user_only`).
- `registry_meta()` regex-scrapes `registry.yaml` for `scope`/`status` per skill (no yaml dep).

### Live host state — `host_live_state(host, target)`
Iterates the host dir; per entry: symlink into REPO → `catalog`; symlink elsewhere → `foreign-link`; plain dir → `local-dir`.

### Project strays / conflicts — `find_conflicts(cat)`
- duplicate active skill names across catalog paths;
- host entries shadowing a catalog skill (`foreign-link`/`local-dir` with its own `SKILL.md`; category folders w/o `SKILL.md` skipped);
- `stale catalog link` — linked but not in effective manifest (rerun bootstrap);
- manifest-wanted but not linked.

### Project view — `project_view(dir, cat)`
Per directory: context files (`CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`, symlink target + bytes, "always loaded"); project skills in `<dir>/.claude/skills`; global skills visible; shadowed (project wins over global); `.pi/` presence note.

---

## 2. X-ray — `command_center.xray(project, harness)`

Computes, per **project × harness**, the assembled context preview grouped into
`always` (loaded every session), `skill_index` (name+desc injection cost),
`could_see` (bench skills, cost-if-enabled), `unmeasured`, `notes`, plus a
`window` block from `harness_config()`.

Token estimate is **chars/4** (`toks()`), flagged as an estimate everywhere.

### Provenance model (the honesty contract, module docstring)
Each entry carries `provenance`:
- **measured** — real file bytes read (`add_file` → `read_if`, byte length). Token count still estimated chars/4.
- **configured / config-override** — read from a real harness config file (path shown). E.g. codex `model_context_window` from `config.toml` regex.
- **spec (model-spec)** — window from `KNOWN_MODELS` table (documented windows) or `MODEL_PATTERNS` family regex (`[1m]`→1M, claude/fable/opus/…→200k).
- **assumed** — `KNOWN_MODELS` rows tagged `"assumed"`; UI suffixes "(assumed)".
- **unknown** — rendered "not measurable / not in table", never an invented number. E.g. "harness system prompt + core tool schemas" is always `unknown`.

### Per-harness derivation
- **claude-code**: measures user `~/.claude/CLAUDE.md` + project `CLAUDE.md`; follows `@path` imports recursively (`claude_imports`, depth ≤ 2); skill index from `~/.claude/skills` (global) + `<proj>/.claude/skills` (project overrides global = shadow); `user_only` skills cost 0; notes `.mcp.json`; system prompt/tools = unknown.
- **codex**: global + project `AGENTS.md` measured; explicit note "no skill loader"; system prompt = unknown.
- **pi**: global/project `AGENTS.md`; package skills at `~/.pi/.../agent-skills/skills` globbed `*/*`, index cost tagged **assumed** ("actual loading behavior unverified").

`harness_config()` reads each harness's model out of its config (claude `settings.json.model`; codex `config.toml` regex for `model`/`model_context_window`; pi `settings.json` `defaultModel`/`defaultProvider`) and resolves a window via `model_window()`.

---

## 3. Apply — staged mutations → one commit

Model: UI stages N toggles, then `POST /api/apply` → `apply_batch(changes)`.

- `apply_edit(rel, host, machine, enable)` — one manifest edit, **no commit**:
  - `machine ∈ ("", global)` → edit global `hosts/<host>.manifest` (append/remove the repo-relative line).
  - otherwise → edit `hosts/overrides/<machine>/<host>.manifest` using `+rel`/`-rel` diff lines against base manifest.
- `apply_batch` applies all edits, then **one** `commit_push("apply N changes", ["hosts"])`, then — if any change targets this machine/global — runs `bootstrap.sh` locally to re-materialize symlinks.
- `commit_push()` — `GIT_LOCK`-guarded; `git add -- <paths>` (scoped, avoids sweeping unrelated dirty files), commit `cc: <msg>`, `pull --rebase`, `push` (best-effort; "committed (push failed…)" on failure). `no-op` when nothing staged.

### Committed (repo, syncs to fleet) vs machine-local (never committed)
- **Repo-committed** (`/api/file` non-LOCAL, `apply`, `skill-rollback`, `skill-fork`): `hosts/*.manifest`, `hosts/overrides/*`, `skills/**/SKILL.md`, `registry.yaml`, `instructions/*`, `README.md`. `repo_rel()` refuses path escapes.
- **Machine-local, live-edited, NEVER committed** (`LOCAL_FILES`): `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.codex/AGENTS.md`, `~/.codex/config.toml`, `~/.pi/agent/settings.json`. Saved directly to disk with msg "this machine only".

### Skill editor mutations
- `skill_detail` / `skill_versions` — `git log --follow` history over the git-tracked path (`_git_path` resolves symlinked skills into `vendor/`). `pinned = git_path startswith vendor/`.
- `skill_rollback(name, commit)` — validates `[0-9a-f]{6,40}`, `git checkout <commit> -- <path>`, commit+push.
- `skill_fork(name, content)` — copies a pinned `vendor/…` skill into `skills/<category>/`, repoints link, appends a provenance comment to `registry.yaml`, commit+push.

---

## 4. Heartbeat / fleet

- **State branches**: each machine pushes to `refs/heads/state/<machine>` carrying a single `state.json` blob.
- `push_heartbeat()` builds the branch **without touching the working tree/index**: private `GIT_INDEX_FILE`, `hash-object -w`, `read-tree --empty`, `update-index --cacheinfo`, `write-tree`, `commit-tree`, `update-ref refs/heads/state/<machine>`, `push -f`. Temp index file removed after. This is the trickiest git plumbing in the codebase.
- `local_heartbeat()` payload: machine, ts, HEAD short commit, dirty flag, per-host wanted/linked counts, conflicts, harness CLI versions (`claude/codex/pi --version`, cached), pi_package presence.
- `fleet_state()` — `git fetch origin +refs/heads/state/*:refs/remotes/origin/state/*`, `for-each-ref`, `git show <ref>:state.json` per machine; overlays the live local heartbeat (`live:True`).
- **Usage/session-log scanning** (`agentkit.usage_events`):
  - Claude: `~/.claude/projects/**/*.jsonl`, `scan_claude_file` — JSON lines with `tool_use` name `Skill`, extracts skill (after `:`), ts, cwd.
  - Pi: `~/.pi/agent/sessions/**/*.jsonl`, `scan_pi_file` — best-effort: `/slash` invocations in user text matched against known skills (Pi "does not yet log a canonical skill-call event").
  - mtime+size **cache** in `~/.cache/agent-skills/{claude,pi}.json` to skip unchanged files. `usage_table` aggregates count/last/projects/harnesses; supports `--days`.
- **converge** (daemon entry): `git pull --rebase` → `bootstrap.sh` → `push_heartbeat()`.
- **install-daemon**: launchd (macOS: converge every 900s + always-on serve on :4173 + `tailscale serve`) or systemd user timer (Linux).

---

## 5. Data model

### `registry.yaml`
Hand-maintained inventory + policy. Top keys `skills:` / `prompts:` / `pending:`. Per skill (inline-map): `path`, optional `link` (for vendored-active relative symlink), `scope` (`portable | responsibid-only | personal | work` — the client firewall), `status` (`active | inactive`), `upstream`, `note`. agentkit only regex-reads `scope`/`status`; the rest is human doc. **Source of truth for policy; the filesystem/manifests are the source of truth for what's live.**

### `hosts/` manifests
- `hosts/<host>.manifest` — newline list of repo-relative skill dirs (`skills/<cat>/<skill>`), `#` comments. Global baseline.
- `hosts/overrides/<machine>/<host>.manifest` — per-machine diff: `+path` adds, `-path`/`-name` removes.
- `effective_manifest(host)` = base ⊕ overrides. Consumed by both the CLI and `bootstrap.sh`.
- Everything materializes through `skills/` (active vendored items are relative symlinks there → Pi's wholesale `skills/` load sees the same active set). Codex not wired (phase-2 renderer). `bootstrap.sh` is idempotent: links what it owns, prunes stale owned links, never touches foreign/real files (reports conflicts).

### UI
Three views (single inlined SPA): **Context** (x-ray), **Skills** (matrix + editor with markdown preview, tags, fork, rollback), **Fleet**. JSON API: `/api/state|harness-config|skill|skill-versions|fleet|xray|file|tree` (GET), `/api/apply|skill-rollback|skill-fork|file|sync|heartbeat` (POST).

---

## 6. Port sizing (Rust vs keep-as-Python)

| Capability | Effort in Rust | Risk | Notes |
|---|---|---|---|
| Catalog / frontmatter / registry scrape | **Low** | Low | Filesystem glob + regex. `serde_yaml` could replace regex hacks. Mechanical. |
| Manifests + overrides + effective merge | **Low** | Low | Pure string/set logic. |
| host_live_state / conflicts / project_view | **Low-Med** | Low | Symlink resolution (`std::fs::read_link`, `symlink_metadata`). Straightforward. |
| X-ray assembly + provenance tagging | **Med** | Med | Lots of harness-specific branching + `@import` recursion; must preserve the honesty contract exactly. Logic is simple but detail-dense; easy to drift. Port carefully with fixtures. |
| Model window table | **Low** | Low | Static table; but it is **live data that changes** — keep it trivially editable (config file, not compiled-in). |
| Usage/session-log scanning + cache | **Med** | Med | JSONL streaming, per-file mtime/size cache. Pi scanner is already "best-effort/unverified" — a known-fragile area regardless of language. |
| Apply (staged → 1 commit → bootstrap) | **Med** | Med | Needs a git story (see below) + re-implement bootstrap's link/prune. |
| bootstrap.sh (symlink materialize/prune) | **Med** | Med | Bash today; porting to Rust removes the shell dep but must exactly match ownership/prune/conflict rules. |
| **Heartbeat plumbing** (private index, hash-object→commit-tree→push -f state branch) | **High** | **High** | The single hardest piece. Uses low-level git plumbing with a side index file. Either shell out to `git` (safe, matches today) or use `git2`/`gitoxide` (more work, must replicate the empty-tree/single-blob branch exactly). |
| Git ops generally (commit_push, log --follow, checkout, fetch state/*) | **Med-High** | Med | `--follow` across symlink→vendor path resolution is subtle. Shelling out to `git` is by far the lowest-risk path. |
| launchd/systemd daemon install | **Low-Med** | Low | Tauri has autostart plugins; or keep generating plists/units. Platform-specific either way. |
| Web SPA (PAGE) | **N/A → rebuild** | Med | ~900 lines inlined HTML/CSS/JS. In Tauri this becomes the webview frontend — a rewrite, not a port, but it is genuinely just a JSON-API client. |

**Hard/risky parts, ranked:** (1) heartbeat git plumbing; (2) git integration overall (`--follow` + symlink/vendor path resolution, rebase/push best-effort semantics); (3) x-ray provenance fidelity; (4) exact bootstrap symlink ownership/prune parity; (5) fragile Pi usage scanner.

**Recommended strategy:** shell out to the system `git` binary from Rust for every git operation rather than adopting `git2`/`gitoxide` — it eliminates the highest-risk reimplementation (heartbeat, `--follow`, rebase semantics) at the cost of a `git` dependency the app already implicitly requires. The rest (catalog, manifests, x-ray, apply) is mechanical filesystem + regex work that ports cleanly. The web UI is a from-scratch rebuild in the Tauri webview but is a thin client over an unchanged JSON contract.
