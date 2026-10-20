# Quench

See exactly what enters your coding agent's context in each project, and turn
skills on or off without hand-editing settings files.

Quench is a local desktop app. Open a project and it shows what **Claude Code**
loads there, with a cost for each item:

- **Always loaded**, following [Claude Code's memory docs](https://code.claude.com/docs/en/memory):
  - The managed policy `CLAUDE.md`, `~/.claude/CLAUDE.md` and `~/.claude/rules/`.
  - Every `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` from the filesystem root
    down to the project. If there are none, `AGENTS.md` / `.claude/AGENTS.md` instead.
  - `.claude/rules/`. Rules with `paths:` only load when matching files are touched.
  - `@imports`, up to four hops. Code spans, fences and HTML comments aren't imported or
    counted.
  - The first 200 lines (max 25 KB) of the project's auto-memory `MEMORY.md`.

  A symlinked file is counted once. Identical copies both count, and are flagged.

- **Skills:** each skill's index entry (name + description) is always loaded; its body
  only when used. Skills with `disable-model-invocation` and overridden skills are
  priced the way Claude Code treats them.
- **MCP servers:** user, local and project (`.mcp.json`) servers, with approval state.
  When one name appears in several scopes, the one Claude Code uses is marked.
  - URLs show only `scheme://host`.
  - Commands show only the program name.
  - Env and header values are never read into the app.

Per skill you can pick **Inherit / On / Name only / Slash only / Off** for this
project. Changes queue up, show the exact file diff, and apply together.

Quench writes only `.claude/settings.local.json`, Claude Code's personal per-project
settings file, in the same place Claude Code keeps it:

- At the repository root.
- For a worktree, at the main checkout's root.
- Outside git, or when the repo root is your home folder, in the project folder itself.

Every other key in that file is kept. Undo reverses only Quench's own change, so edits
Claude Code made in between survive.

**Not an orchestrator.** Quench never runs agents. It governs what they load.

## Honest numbers

| What you see  | Where it comes from                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Bytes         | Measured from disk                                                                                                                             |
| Tokens        | Estimated as `bytes / 3`, calibrated against Claude Code's own `/context` (instruction files ran 2.4–2.7 bytes/token, skill index entries 2.9) |
| MCP tool cost | Shown as **unknown**: config alone can't tell whether a server connected or how big its tools are                                              |
| Plugins       | Listed as **not yet scanned**                                                                                                                  |

## Status

v0, Claude Code only. Built and tested on Linux; macOS should work but is untested. Codex, Pi and Hermes are scanned by the
core but not yet shown. Multi-machine sync is designed for (every change is
journaled with its project, machine and harness) but not built.

## Install

There are no prebuilt releases yet. Build from source:

Prerequisites:

- Rust (stable, via `rustup`).
- Node 22.18+ or 24.11+.
- pnpm 11. Install it from outside the repository (`cd ~ && npm i -g pnpm@11`): npm
  refuses to run inside the repo because of `devEngines`.
- On Linux, the WebKitGTK and GPU libraries listed in
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The GPUI app's folder picker
  also needs an xdg-desktop-portal backend with a file chooser, such as
  `xdg-desktop-portal-gtk`.

```sh
pnpm install
pnpm dev                      # Tauri app (window + tray)
cargo run -p quench-gpui      # the same app as a native GPUI window
```

Pass a project path to open it directly, e.g. `cargo run -p quench-gpui -- ~/code/my-app`.

Headless, for scripts or bug reports:

```sh
cargo run -p quench-app --example context_view -- <project>   # JSON of the view
cargo run -p quench-app --example toggle -- <project> <skill> off
cargo run -p quench-app --example toggle -- <project> undo
```

## What Quench writes

| Path                                           | Contents                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `.claude/settings.local.json` (location above) | `skillOverrides` entries you applied (other keys untouched)        |
| `.git/info/exclude`                            | One line keeping that file out of git, if Quench created it        |
| `~/.quench/local/machine.json`                 | A random machine id and its label                                  |
| `~/.quench/local/recent.json`                  | Recently opened projects                                           |
| `~/.quench/local/journal.jsonl`                | One line per applied or undone change                              |
| `~/.quench/local/backups/`                     | The settings file as it was before each apply, for manual recovery |

Set `QUENCH_HOME` to use a different directory than `~/.quench`.

## Repository layout

- `crates/quench-core` — what loads, from disk: instruction chain, skills, MCP
  servers, project identity, settings layers. No UI.
- `crates/quench-app` — app state, commands and the view models every UI renders.
  TypeScript types are generated into `apps/desktop/src/generated` by `cargo test`.
- `apps/desktop` — Tauri v2 + React frontend.
- `apps/gpui` — GPUI frontend. Both frontends ship until one is retired.
- `docs/` — architecture, scope and the decision log (`docs/decisions.md`).

Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets`,
`pnpm exec vp check`.

## License

MIT — see [LICENSE](LICENSE).
