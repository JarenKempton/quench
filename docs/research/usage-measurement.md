# Research: honest skill-usage measurement per harness

**Question (issue #26):** What is honestly measurable about skill usage, per harness,
on the local machine — beyond Claude Code session-log scanning? Jaren wants a per-skill
usage metric ("how many times does this skill get used") that is *not* chained to Claude
Code alone — "there's got to be another way."

**Method:** empirical inspection of on-disk data for all four harnesses on this machine
(Claude Code, Codex, Pi, Hermes) + the prior-art POC scanner
(`~/Documents/programming/agent-skills/scripts/agentkit`) + primary-source docs for each
harness. Provenance classes per Hone principle 1: **measured** (bytes read here), **spec**
(documented / schema-provable), **assumed** (inferred, labeled), **unknown** (not
measurable — never invent a number).

---

## TL;DR — there *is* another way, and it's hooks (not more log-scanning)

There are **two** local mechanisms, and they give very different coverage:

1. **Passive log/DB scanning (zero install)** honestly recovers a per-skill count on
   **only one** harness — **Claude Code** — because it is the only one that persists a
   *discrete, skill-tagged* event (`Skill` tool_use). Pi logs generic tool calls but never
   tags a skill; Codex has no skills at all; Hermes stores tool calls in SQLite but not as
   a distinguishable skill event.

2. **Active hook / extension instrumentation (Hone installs a hook)** — **this is the
   "another way."** A discrete skill-invocation *action* actually exists on **three of the
   four** harnesses: Claude Code (`Skill` tool), Pi (skill = slash-command), Hermes
   (skill = slash-command). All three expose a hook/event that fires on that action
   (Claude Code `PostToolUse` matcher, Pi `tool_call`/`command`, Hermes `command:*` /
   `pre_tool_call`). So Hone *can* count skill usage cross-harness **in real time** — if it
   installs and maintains a small per-harness hook and handles each harness's consent
   model. **Codex is the lone exception: it has no skills feature, so there is nothing
   skill-shaped to count on Codex by any mechanism.**

**The framing to sharpen:** "per-skill usage count, per harness, from logs" is the wrong
shape — passive logs only deliver Claude Code. The honest cross-harness metric requires
*installed hooks*, which is a real feature with real cost (write + install + maintain 3
hook formats, per-harness consent UX), not a free scan. And the count's meaning differs:
Claude Code counts model-invoked skill calls (misses a user typing `/skill` directly);
Pi/Hermes count slash-command activations.

**Recommendation: DEFER the cross-harness build; BUILD only the cheap Claude Code passive
scan now and reserve the metric slot.** Details at the bottom.

---

## Mechanism coverage matrix

| Harness | Discrete skill *action* exists? | Passive scan (no install) | Active hook (Hone installs) | Kernel trace helps? |
|---|---|---|---|---|
| **Claude Code** | Yes — `Skill` tool | **Yes** — `Skill` tool_use in JSONL (count+ts+cwd). Proven | Yes — `PostToolUse` matcher on `Skill` (real-time) | No (harness logs it) |
| **Codex** | **No** — no skills feature | No skill signal (no skills) | No skill hook (no `Skill` tool; skills don't exist) | No (nothing to observe) |
| **Pi** | Yes — skill = slash-command | No — logs generic `tool_call`s, never tags a skill | Yes — `tool_call`/`command` extension event (real-time) | No (would see only bulk load) |
| **Hermes** | Yes — skill = slash-command | Weak — SQLite tool-call rows, no discrete skill event | Yes — `command:*` / `pre_tool_call` hook (real-time) | No (would see only bulk load) |

---

## Per-harness findings

### 1. Claude Code — clean discrete signal, two ways to read it (measured + spec)

| Aspect | Finding | Provenance |
|---|---|---|
| Session logs | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, JSON-lines. Retained 30 days by default (`cleanupPeriodDays`) | measured + spec ([data-usage docs](https://code.claude.com/docs/en/data-usage)) |
| Skill invocation event | `tool_use` entry with `name:"Skill"`, `input.skill` = skill name; parent line carries top-level `timestamp`, `cwd`, `sessionId` | measured |
| Reliability | High. Discrete, first-party, deduped by `sessionId`. Verified: counted `grill-with-docs`×2, `grill-me`×1 in the hone project from real logs | measured |
| Hooks (real-time) | `PreToolUse`/`PostToolUse` match on tool name `Skill`; hook gets `tool_name`, `tool_input`, `cwd`, `session_id`, `tool_response` on stdin. **Caveat:** a user typing `/skillname` directly bypasses the tool path (prompt-expansion, not a tool call) — so a hook undercounts direct slash use; log-scanning of the `Skill` tool_use has the same blind spot | spec ([hooks docs](https://code.claude.com/docs/en/hooks)) |
| Telemetry | OpenTelemetry metrics supported (`DISABLE_TELEMETRY` opt-out) | spec |
| Kernel tracing needed? | No — the harness logs the event itself | measured |

**Honest report:** exact per-skill invocation count, last-used, per-project (from `cwd`),
timeline. **Fabrication risk:** none for the count; token "cost" remains chars/4 estimate
(label as estimate, as the POC does). **Cost:** Low. The POC already does this
(`scan_claude_file`, ~15 lines) with mtime+size caching. A `PostToolUse` hook is an
optional real-time alternative to scanning.

### 2. Codex — no skill concept; nothing skill-shaped to count (measured + spec)

| Aspect | Finding | Provenance |
|---|---|---|
| Session logs | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; types `session_meta` (has `cwd`), `event_msg`, `response_item`, `turn_context` | measured |
| Skill loader | **None.** Codex loads only the `AGENTS.md` chain — no skill system (prior-art + empirical + docs) | measured + spec |
| Tool calls logged | Yes: `function_call` names seen = `exec_command`, `js`, MCP tools. No skill tool exists | measured |
| Hooks | Full system — 10 events incl. `PreToolUse`/`PostToolUse` (also `SessionStart`, `Stop`, `UserPromptSubmit`, `SubagentStart/Stop`, `PermissionRequest`, `PreCompact`/`PostCompact`). But they fire for Bash/`apply_patch`/MCP — **no `Skill` tool to match**. Feature is recent/evolving (~v0.114), some reports of it behaving experimentally | spec ([Codex hooks](https://developers.openai.com/codex/hooks)) + measured (`hooks=true`, 3 events observed locally) |
| Telemetry | OpenTelemetry via `[otel]` in `config.toml` (API/stream/tool counters). Gap: `codex exec` no metrics; `codex mcp-server` no OTEL | spec |
| Kernel tracing needed? | Moot — no skill action to observe | measured |

**Honest report:** *nothing* as "skill usage." Hone renders skills for Codex as an
`AGENTS.md` index; the model "using" one means it read a file or ran a command —
indistinguishable from any other read, and reads aren't observable without kernel
instrumentation. The only honest Codex number is **"skill X is exposed in the Codex index
(yes/no)"** — configuration state, not usage. **Fabrication risk:** high if any Codex
"usage count" is shown — there's no event behind it. **Cost of a real count:** N/A
(impossible honestly).

### 3. Pi — skill *is* a slash-command; hookable live, invisible to passive logs (measured + spec)

Pi = `earendil-works/pi` (Mario Zechner / "badlogic"). Config at `~/.pi/agent/AGENTS.md`.

| Aspect | Finding | Provenance |
|---|---|---|
| Session logs | `~/.pi/agent/sessions/<encoded-project>/*.jsonl`; structured `message` entries | measured |
| Tool calls logged | Yes, well-structured: `toolName`/`name` = `read`, `edit`, `bash`, `write`, `web_fetch`, `web_search`, `subagent`, `ask_user_question` (counted across all local sessions) | measured |
| Skill in logs | **Not tagged.** No `skill` tool_use, no slash `tool_use` event persisted. Skills are packages (`SKILL.md` dirs) "loaded on-demand into context"; skill commands run through the command system but leave no skill-tagged log row | measured + spec ([skills doc](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)) |
| POC handling | `scan_pi_file` = heuristic: regex `/slash` tokens in user text vs known skills. Docstring: "Pi does not (yet) log a canonical skill-call event." Fragile: undercounts model-invoked skills, misattributes | measured |
| Hooks (real-time) | **Yes** — extension event system: `tool_call` ("before tool executes; can block"), `tool_result`, plus `session_start`, `turn_start/end`, etc. Skills/prompt-templates register as `/commands` via `pi.registerCommand()`. An installed extension could count skill-command invocations live | spec ([extensions doc](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)) |
| Telemetry / OTEL | None documented | assumed |
| Kernel tracing needed? | Would only see the startup bulk read of `skills/`, not which skill was used | spec |

**Honest report:** passive = **presence only** ("skill was in Pi's loaded package") — the
slash-regex "count" is assumed-class and unreliable; per principle 1 it must **not** be
shown as a hard count. Active = a real per-skill count **if** Hone ships a Pi extension
hooking `tool_call`/`command`. **Cost:** heuristic = Low/misleading; honest live count =
Medium (write + install + maintain a Pi extension package).

### 4. Hermes — skill = slash-command; SQLite store + hooks, no discrete skill event (measured + spec)

Hermes = `NousResearch/hermes-agent`. `HERMES_HOME` = `~/.hermes` (config, skills, sessions, logs).

| Aspect | Finding | Provenance |
|---|---|---|
| Store | `~/.hermes/state.db` (SQLite). `sessions` has `cwd`, `source`, `tool_call_count`; `messages` has `tool_name`, `tool_calls`, `tool_call_id`, `timestamp`, `token_count` | measured (schema) |
| Data present here | **Empty** on this machine (0 sessions, 0 messages) — schema provable, data not verifiable locally | measured |
| Skills | `~/.hermes/skills/` + `.skills_prompt_snapshot.json` = manifest of 72 skills (path→hash,size) injected into the prompt. Catalog, not usage. Every installed skill **becomes a slash command** | measured + spec |
| Skill in store | **No discrete skill event.** Docs: "skill activation appears implicit within broader tool-call and LLM-response flows." Whether activation writes a distinguishable `tool_name` row is **unknown** (and unverifiable — DB empty here) | unknown |
| Hooks (real-time) | **Yes** — rich system: `pre_tool_call`/`post_tool_call`, `pre_llm_call`/`post_llm_call`, `on_session_start/end`, and gateway `command:*` (wildcard). Shell hooks in `config.yaml` `hooks:` block (empty here) + `hooks/` dir; consent via `~/.hermes/shell-hooks-allowlist.json`, managed by `hermes hooks`. Skill use is catchable via `command:*` + tool hooks | spec ([hooks doc](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md)) + measured (`hooks: {}` key present) |
| Telemetry / OTEL | None documented | assumed |
| Kernel tracing needed? | No — a hook or a tool row would capture it | spec |

**Honest report:** passive = **presence** (skill in the injected manifest); *if* a future
check finds Hermes writes a skill-tagged `tool_name` row, `state.db` becomes the **cleanest
scan target of any harness** (one indexed SQL query → count+last+`cwd`). Active = real live
count via a `command:*`/`pre_tool_call` hook. **Cost:** verification spike = Low; honest
live count = Medium (hook + Hermes's allowlist consent flow).

---

## Cross-cutting truths

1. **A discrete skill *action* exists on 3 of 4 harnesses** (Claude Code Skill tool; Pi &
   Hermes skill-as-slash-command). Only Codex lacks skills entirely. So the metric is
   *conceptually* well-defined almost everywhere — the gap is **persistence**, not
   concept: passive logs tag the skill only on Claude Code.

2. **"Another way" = installed hooks, and it genuinely works** on Claude Code, Pi, and
   Hermes (all expose a tool-call/command event that fires on skill invocation). This is
   the honest cross-harness route Jaren was reaching for. Its cost is real: three
   different hook mechanisms, per-harness install + consent (Hermes has an allowlist;
   Claude Code needs `settings.json`; Pi needs an extension package), and ongoing
   maintenance as each harness's hook API evolves (Codex's is already noted as unstable).

3. **Kernel read-listening stays useless here.** `docs/architecture.md` rules out
   filesystem read-listening without eBPF/Endpoint Security. Even *with* it, all you'd
   observe is the harness bulk-reading its skills dir at startup — a *load*, not a *use*,
   and it can't say which skill the model leaned on. Kernel tracing unlocks **no** per-skill
   usage count on any harness. Refuted per-harness.

4. **Prior-art "High/High" sizing — corrected.** `prior-art-audit.md` sized
   "usage/session-log scanning + cache" as **Med/Med** (the High/High label was on
   *heartbeat git plumbing*, a different row). The *Claude Code* scanner is genuinely
   Low/Low and proven. The risk it flagged is exactly the Pi scanner's fragility — which
   this research confirms is not a language problem but a *no-persisted-signal* problem
   (solvable only by a hook, not a better parser). So: cheap+solid for Claude Code passive
   scan; the cross-harness version is a Med-High *hooks* feature, not a scan.

---

## Recommendation: DEFER cross-harness; BUILD the cheap Claude Code slice; reserve the slot

**Do not build cross-harness usage counting into the current map. Build only the proven,
Low/Low Claude Code passive scanner now, reserve the metric slot in schema + UI, and label
every other harness by its honest provenance.**

Reasoning:

- **The cheap honest signal is Claude Code only.** `scan_claude_file` ports Low/Low and is
  already proven. Shipping it (with mtime+size caching) gives a real, provenance-clean
  number today.
- **The cross-harness version is a *hooks feature*, not a scan — Med-High + ongoing.** It
  means authoring and installing three different hook/extension formats (Claude Code
  `settings.json` hook, Pi extension package, Hermes `command:*` hook with its allowlist
  consent), each with its own consent UX and version-drift maintenance. That is a
  deliberate feature investment, not a free byproduct of scanning — and it belongs with
  the **Ambient / hooks phase (phase 4)** and pays off only once **cloud aggregation
  (phase 3)** exists to roll counts up per-user/per-machine. `mvp-scope.md` already puts
  usage aggregation in phase 3 and lists success-rate metrics as *Out* ("no honest
  signal").
- **Codex will never have a skill count** — design the slot to show "no skill signal (no
  skill loader)" for Codex permanently, not a zero.

**Do now (cheap, honest):**
1. **Reserve the slot.** Add a `usage` field to the skill model / matrix cell so schema +
   UI don't churn later. Default per harness: `unknown` (never blank-implying-zero).
2. **Populate Claude Code** via the `scan_claude_file` port (Low/Low) + caching. Show
   count + last-used + per-project, labeled **measured (Claude Code)**. Note the direct-
   `/skill`-typing blind spot.
3. **Label the rest honestly:** Codex → "no skill signal (no skill loader)"; Pi →
   "exposure only — hook required to count"; Hermes → "not yet measured — hook or SQLite
   check required". **Do not** ship the Pi slash-regex heuristic as a count.
4. **One tiny verification spike (optional, Low):** on a *used* Hermes install, check
   whether skill activation writes a distinguishable `tool_name` row in `state.db`. If yes,
   Hermes gets a passive, indexed-SQL count (cleaner than Claude Code's JSONL) for free —
   fold it in early.

**Defer to phase 3/4:** the installed-hooks cross-harness counter (Claude Code
`PostToolUse` + Pi extension + Hermes `command:*`), wired to cloud aggregation. Keep the
reserved slot ready so nothing has to be reshaped when it lands.

**Net:** the valuable, honest slice (Claude Code count) is cheap — build it as a
*reserved, mostly-empty* metric. The cross-harness dream is honestly achievable, but only
via installed hooks (a phase-3/4 feature), never from passive logs on three of four
harnesses. So reserve the slot, ship the one true column, and defer the rest.
