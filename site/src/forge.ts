import { kilo, layers, servers, skillUse, startTokens } from "./context.ts";

const kept = servers.find((s) => s.called > 0)!;
const idle = servers.find((s) => s.called === 0)!;
const chars = (name: string) => layers.find((l) => l.name === name)!.chars;
const total = layers.reduce((n, l) => n + l.chars, 0);
const unusedSkills = skillUse.listed - skillUse.used;

const WIDTH = 460;
const PLATE = 4;
const TRACKER = 88;
const BASE = ["System prompt", "Built-in tools", "Instruction files"];

const cutChars = chars(`MCP: ${idle.server}`) + (chars("Skill list") * unusedSkills) / skillUse.listed;
const keptW = WIDTH - Math.round((WIDTH * cutChars) / total);
const baseW = keptW - TRACKER - skillUse.used * PLATE;
const baseChars = BASE.reduce((n, b) => n + chars(b), 0);

type Kind = "base" | "tracker" | "plate" | "block";
const parts: { x: number; w: number; kind: Kind }[] = [];
let x = 0;
const push = (w: number, kind: Kind) => {
  parts.push({ x, w, kind });
  x += w;
};
BASE.forEach((b) => push((baseW * chars(b)) / baseChars, "base"));
push(TRACKER, "tracker");
for (let i = 0; i < skillUse.listed; i++) push(PLATE, "plate");
push(WIDTH - x, "block");

const usedLabel = `${kept.called} of ${kept.tools} used`;
const idleLabel = [`${idle.called} of ${idle.tools} used`, `${unusedSkills} skills unused`];

export const geo = {
  width: WIDTH,
  keptW,
  parts,
  start: startTokens,
  usedLabel,
  idleLabel,
  note: "you remove them",
};

export const aria = `A production line, run once. A block of starting context is scanned: ${kilo(startTokens)} tokens. Heat shows what gets used, including a server with ${usedLabel}. One end stays cold: ${idleLabel.join(", ")}. You remove it, and a press breaks it off into the scrap bin. The rest is quenched in water and clamped onto a cart.`;
