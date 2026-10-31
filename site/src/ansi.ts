const ON: Record<string, string> = {
  "1": "b",
  "2": "dim",
  "30": "ink",
  "31": "r",
  "32": "g",
  "33": "y",
  "36": "c",
  "90": "d",
  "41": "bg-r",
  "43": "bg-y",
  "45": "bg-m",
  "46": "bg-c",
  "100": "bg-d",
};

const OFF: Record<string, string[]> = {
  "0": Object.values(ON),
  "22": ["b", "dim"],
  "39": ["ink", "r", "g", "y", "c", "d"],
  "49": ["bg-r", "bg-y", "bg-m", "bg-c", "bg-d"],
};

const SGR = new RegExp(`(${String.fromCharCode(27)}\\[[0-9;]*m)`);

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function ansiToHtml(text: string): string {
  let active: string[] = [];
  return text
    .trimEnd()
    .split(SGR)
    .map((part) => {
      const codes = SGR.test(part) ? part.slice(2, -1) : undefined;
      if (codes !== undefined) {
        for (const code of codes.split(";")) {
          const on = ON[code];
          if (on) active = [...active, on];
          const off = OFF[code];
          if (off) active = active.filter((c) => !off.includes(c));
        }
        return "";
      }
      if (!part) return "";
      return active.length
        ? `<span class="${[...new Set(active)].join(" ")}">${escape(part)}</span>`
        : escape(part);
    })
    .join("");
}
