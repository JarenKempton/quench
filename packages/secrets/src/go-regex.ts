export function goRegex(source: string, flags: string): RegExp {
  const caseless = source.startsWith("(?i)");
  const body = translate(caseless ? source.slice(4) : source);
  return new RegExp(body, caseless ? `${flags}i` : flags);
}

function translate(source: string): string {
  const text = source.replaceAll("\\z", "$").replaceAll("(?P<", "(?<");
  const pending = [0];
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (c === "[") {
      const end = classEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith("(?i)", i)) {
      out += "(?i:";
      pending[pending.length - 1]! += 1;
      i += 4;
    } else if (c === "(") {
      pending.push(0);
      out += c;
      i++;
    } else if (c === ")") {
      out += ")".repeat(pending.pop() ?? 0) + ")";
      i++;
    } else if (c === "|") {
      const open = pending[pending.length - 1]!;
      out += ")".repeat(open) + "|" + "(?i:".repeat(open);
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out + ")".repeat(pending[0] ?? 0);
}

function classEnd(text: string, start: number): number {
  let i = start + 1;
  if (text[i] === "^") i++;
  if (text[i] === "]") i++;
  while (i < text.length && text[i] !== "]") i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}
