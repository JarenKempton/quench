import runs from "./samples/runs.json";
import skills from "./samples/skills.ansi?raw";

type Part = { kind: string; chars: number; count?: number; files?: number; server?: string };

export const run = runs[0];
export const startTokens = run.startingContext.tokens ?? 0;
export const parts = run.startingContext.parts as Part[];
export const callsTo = (server: string) => run.calls.filter((c) => c.server === server).length;

const plain = skills.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const row = plain.match(/Claude Code\s+\d+\s+(\d+)\s+\S+ chars\s+(\d+)\s+(\d+)/)!;
export const skillsListed = Number(row[1]);
export const skillsNeverUsed = Number(row[3]);

export const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
