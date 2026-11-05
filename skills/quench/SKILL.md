---
name: quench
description: Use when asked to edit, improve, fix or test a skill, when a skill seems wrong, stale or missing, or when asked why skill X is failing, not loading or not being used. Reads skills from the Quench hub and proposes changes for the owner to review; never edits installed skill folders.
---

# Quench

Installed skill folders are owned by the Quench fleet. Editing them on disk is reported as a
conflict and never reaches other machines. Change a skill by proposing a new `SKILL.md` to the
hub; the owner reviews and approves it.

## Look before changing

- `quench skill list` — skills assigned to this machine, with their tree hashes.
- `quench skill show <skill>` — the hub's current `SKILL.md` for that skill.
- `quench skills --json` — local records per skill: where it is installed, listing size, how
  often sessions used it, and corrections that followed.
- `quench corrections --context --json` — recurring corrections with the skills in context.

## Propose a change

1. `quench skill show <skill> > /tmp/<skill>.md` and note the tree hash from `quench skill list`.
2. Edit `/tmp/<skill>.md`. Change only that one `SKILL.md`; keep it plain text.
3. `quench skill diff <skill> /tmp/<skill>.md` and check the diff says what you meant.
4. `quench skill propose <skill> /tmp/<skill>.md --base <tree hash> --agent <your name> --harness <claude-code|codex|pi> --session <session id>`

`--agent`, `--harness` and `--session` are recorded as your claims. Add
`--evidence '{"kind":"eval-summary","name":"<eval>","counts":{"pass":3,"fail":1}}'` to cite
an insight card or eval by name and counts only.

The hub refuses binaries, proposals over 64 KiB, too many proposals in an hour, and anything
its secret scan flags. It shows the owner every new URL, shell command, script and credential
mention. Never put secrets, tokens or private paths in a proposal.

If the hub answers that the base is out of date, run `quench skill show` again and redo the
edit on the new content.

## What this cannot do

A proposal changes nothing until the owner approves it with their password. This machine's
proposal access cannot approve, assign skills, roll them out or manage machines. Do not edit
installed skill folders directly, and do not change harness settings to load skills.
