# Naming Brief — Desktop App for AI Agent Skill Control

## Decision: Quench

**The hunt is retired.** The product's name is **Quench** — decided in
[#30](https://github.com/JarenKempton/hone/issues/30) after this brief's process ran to
~225 candidates across 7 gauntlet sweeps plus a brute-force registry scan of all 3,739
common 4–6-letter English words. See #30 for the full rationale (Quench's collision
profile, the pre-launch trademark/registrar checklist) and [docs/decisions.md](decisions.md)
for the ADR. The constraints, taste notes, and kill-list below are kept as the historical
record of how the hunt got there — not a live search anymore.

## What the product is

A cross-harness desktop app (Tauri) that gives a developer **visibility and control over
everything entering their AI coding agents' context** — skills (SKILL.md), instruction
files (CLAUDE.md/AGENTS.md), MCP servers — per project, per harness (Claude Code, Codex,
Pi, …), per machine. Features: scan the machine and find all skills/harnesses; a context
"x-ray" showing exactly what each agent sees; toggle skills per harness/machine/project;
version-controlled skills (git-backed, pinned by hash, diff-on-update, rollback);
provenance and review-before-trust (community skill registries are full of prompt
injection — this app is the safe counterweight); optional cloud account for multi-machine
sync and sharing skills with team/friend circles; local-only mode is first-class.

**Positioning in one line:** turn the chaos of AI agent configuration into order — make
the user the driver, not the passenger.

## Naming constraints (hard)

1. **NOT an orchestrator.** The app does not drive/conduct/pilot agents. Reject anything
   implying command of agents: conductor, pilot, maestro, helm, captain, shepherd, etc.
2. **Nouns strongly preferred.** Generally avoid verbs (Hone was the one exception the
   user liked).
3. **No collisions with dev/AI tools.** Must survive a check against: GitHub orgs/repos,
   npm, crates.io, Homebrew, existing dev/AI products, domains. Known kills so far:
   Kiln (Kiln AI — kiln.tech, same category), Hone (too close to Hono, the web framework),
   Anneal (getanneal.com), Lathe (lathe.sh), Helm, Forge, Ember, Codex, Opus, Atlas,
   Compass, Cargo, Crate, Kestrel (ASP.NET), Kernel, Mise (jdx/mise), Loom, Caddy, Valet.
4. **No invented top-level jargon** that fights existing standards (SKILL.md spec at
   agentskills.io, AGENTS.md, marketplace.json).

## The user's taste (learned over ~13 rejected batches)

- **Liked (sound + feel):** Hone, Kiln, Gimbal ("cool sound, wrong context").
  Pattern: short (1–2 syllables, 4–6 letters), quiet/serious real words, soft consonants,
  often k/h/g starts and -n/-l closes. Sounds like a modern dev product (Vercel/Linear/
  Tauri register), NOT cutesy, NOT a joke, NOT visibly clever.
- **"Sort of good" meaning, wrong sound:** Muster, Manifest.
- **Meaning themes that resonate:** sharpening/refinement, kiln/craft warmth,
  chaos→order, control in the user's hands.
- **Explicitly disliked:** whimsical/British-twee (Fettle "sounds dumb"), gear/military
  metaphors (Loadout, Holster, Armory), obvious skill-words (Knack, Deft, Repertoire),
  and anything where the metaphor is the point rather than the sound.

## Every name already REJECTED (do not re-propose)

Loadout, Armory, Quiver, Rack, Muster*, Manifest*, Roster, Ledger, Quartermaster,
Outfitter, Satchel, Tacklebox, Repertoire, Knack, Forte, Skillet, Sleight, Vantage,
Periscope, Holster, Rig, Stash, Trove, Kitted, Drydock, Hangar, Paddock, Bosun,
Whetstone, Docket, Rollcall, Skillsmith, Whet, Tune, Tend, Keen, Etch, Sift, Drill,
Buff, Temper, Deft, Adept, Mettle, Finesse, Jig, Flint, Ingot, Burr, Emery, Grit,
Hearth, Guild, Palette, Facet, Hew, Pare, Vet, Mint, Kern, Rune, Tarn, Loam, Glyph,
Kempt, Rein, Keel, Taut, Poise, Trellis, Canon, Folio, Spool, Sheaf, Linchpin, Writ,
Primer, Cleat, Reeve, Ordo, Ordna, Kanso, Waza, Kata, Norn, Klar, Nock, Kosmo, Techne,
Takt, Hale, Lagom, Griff, Sano, Modus, Arete, Hanko, Kilter, Kihon, Wright, Faber,
Yare, Kanri, Stead, Rin, Hexis, Escapement, Crown, Bezel, Jewel, Sorts, Colophon,
Pica, Galley, Legend, Gnomon, Datum, Grove, Arbor, Bower, Comb, Strata, Bedrock, Lee,
Cove, Eddy, Ratchet, Detent, Pawl, Crystal, Ward, Hasp, Tumbler, Jess, Mews, Clef,
Dial, Squelch, Focal, Larder, Sieve, Fettle, Kiln†, Hone†, Anneal†, Lathe†, Gimbal‡

\* meaning OK, sound rejected  † user liked it, killed by collision  ‡ sound liked,
context rejected — this phonetic shape (GIM-bal: 2 syllables, g/b, -al/-el) is a live
target.

**Latest batch, not yet reviewed by the user:** Gavel, Gimlet, Nimble, Gimble, Thimble,
Gable, Treadle, Trestle, Corbel, Rivet.

## What to produce

10–20 candidates per round. For each: the name, pronunciation if non-obvious, a ONE-line
meaning note (the user cares about sound first; meaning is a bonus), and a quick
known-collision flag. Coined/invented words are allowed and welcomed (Tauri/Deno school)
— tune them to the phonetics above. Before the user commits to any finalist, run a real
collision check: GitHub org, npm, crates.io, Homebrew, domains (.com/.dev/.sh),
"<name> AI", "<name> dev tool" searches.
