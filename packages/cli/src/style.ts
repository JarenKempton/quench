import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

const paint = (format: Format) => (text: string) => styleText(format, text);

export const bold = paint("bold");
export const dim = paint("gray");
export const accent = paint("cyan");
export const good = paint("green");

const BADGES: Format[] = [
  ["bgRed", "black", "bold"],
  ["bgYellow", "black", "bold"],
  ["bgMagenta", "black", "bold"],
  ["bgGray", "white", "bold"],
];

export const colored = () => styleText("red", "x") !== "x";

export const title = (text: string) => styleText(["bgCyan", "black", "bold"], ` ${text} `);

export const heading = (text: string) => `${accent("▍")}${bold(text)}`;

export const badge = (n: number) =>
  colored() ? styleText(BADGES[Math.min(n, BADGES.length) - 1]!, ` ${n} `) : `${n}.`;

export function bar(value: number, max: number, width = 12): string {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
  return colored()
    ? accent("█".repeat(filled)) + styleText(["gray", "dim"], "█".repeat(width - filled))
    : "█".repeat(filled) + "░".repeat(width - filled);
}
