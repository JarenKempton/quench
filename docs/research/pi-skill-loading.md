# Research: How does Pi load skills (index vs full body)?

**Ticket:** JarenKempton/quench#4
**Date:** 2026-07-16
**Verdict:** Pi loads skills as an **INDEX only** (name + description + file path), not full bodies.
**Confidence:** High — read directly from the installed Pi source (primary source, not docs).

## What "Pi" is here

`@earendil-works/pi-coding-agent`, v0.80.7 — the AI coding-agent CLI the user runs
(`pi` on PATH, config under `~/.pi/agent/`, skills installed as git packages via
`settings.json > packages`). This is the correct "Pi", anchored on local evidence; no
public docs were needed because the shipped source is authoritative.

## Mechanism (from source)

Authoritative file:
`~/.nvm/versions/node/v24.11.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js`

1. `loadSkills()` discovers `SKILL.md` files from the user skills dir
   (`~/.pi/agent/skills`), project `.pi/skills`, and explicit `--skill` paths /
   git packages. For each skill it reads **only the YAML frontmatter** (`name`,
   `description`, `disable-model-invocation`) plus the file path — never the body.
2. `formatSkillsForPrompt()` emits an XML index into the system prompt:
   ```
   <available_skills>
     <skill>
       <name>…</name>
       <description>…</description>
       <location>/abs/path/to/SKILL.md</location>
     </skill>
   </available_skills>
   ```
   with the instruction: _"Use the read tool to load a skill's file when the task
   matches its description."_
3. `system-prompt.js` injects this index **only if the `read` tool is available**
   (`customPromptHasRead && skills.length > 0`). The skill **body is loaded lazily,
   on demand, via the normal `read` tool** — i.e. progressive disclosure, the
   Agent Skills standard (skills.js cites https://agentskills.io/integrate-skills).
4. Skills with `disable-model-invocation: true` are excluded from the index
   entirely (invoked only via explicit `/skill:name`).

## Verdict on the prior-art note

The note _"Pi (git packages, loads skills/ wholesale)"_ is **half right and
misleading for token cost**:

- "git packages": correct — skills ship as installed git packages, and the whole
  `skills/` tree is **materialized on disk** wholesale.
- "loads … wholesale": **refuted for context**. Only the index (name + description +
  path) enters the model context up front. Bodies cost tokens only when the model
  chooses to `read` a specific SKILL.md. The "wholesale" applies to disk
  checkout, not context loading.

## Implication for Quench's context x-ray

The honest baseline (always-on) token cost for Pi skills = the XML index:
~a few lines per skill (name + description ≤1024 chars + absolute path), plus a
~3-line preamble. Full SKILL.md bodies are **not** in the baseline; count a body's
tokens only when/if that skill is actually read in a session. This matches Claude
Code's progressive-disclosure model, and differs from any harness that inlines
full bodies.

## Evidence trail

- `~/.pi/agent/settings.json` — `packages: [git:…]`, skill packages installed from git.
- `pi --help` — `--skill`, `--no-skills` ("Disable skills discovery and loading").
- `dist/core/skills.js` — `formatSkillsForPrompt()` (index) + `loadSkillFromFile()`
  (frontmatter only).
- `dist/core/system-prompt.js:29-30,103-104` — injects the index, read-tool-gated.
- A skills package's `README.md` — canonical SKILL.md catalog, standard Agent Skills
  format, consumed by Pi as a package.

## Not verified

- No public Pi doc was fetched (source was authoritative and version-matched). If a
  citable public source is wanted, `docs/skills.md` ships inside the Pi package.
