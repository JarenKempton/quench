import type { Event, Session } from "./model.ts";
import { intern, skillUsesOf } from "./recorded.ts";

export type AskSender = "person" | "automation" | "unknown";

export type SkillAsk = {
  name: string;
  sender: AskSender;
  loaded: boolean;
  oneWord: boolean;
  event: number;
};

export function skillAsks(session: Session, extraNames: readonly string[]): SkillAsk[] {
  const listed = session.events.flatMap((e) => (e.type === "skills" ? e.listed : []));
  const byPath = new Map(listed.flatMap((s) => (s.path ? [[s.path, s.name] as const] : [])));
  const phrases = [...new Set([...listed.map((s) => s.name), ...extraNames])].flatMap((name) => {
    const words = wordsOf(name.slice(name.lastIndexOf(":") + 1));
    return words.length ? [{ name, words }] : [];
  });
  if (!phrases.length) return [];
  const asks: SkillAsk[] = [];
  let open: SkillAsk[] = [];
  for (const [index, event] of session.events.entries()) {
    for (const name of skillUsesOf(event, byPath))
      for (const ask of open) if (ask.name === name) ask.loaded = true;
    if (event.type !== "message" || event.author !== "user") continue;
    const next = session.events[index + 1];
    const command = next?.type === "invocation" && next.by === "user";
    const words = command ? [] : wordsOf(event.text);
    const found = phrases.flatMap(({ name, words: phrase }) =>
      matches(words, phrase)
        ? [
            {
              name: intern(name),
              sender: senderOf(event),
              loaded: false,
              oneWord: phrase.length === 1,
              event: index,
            },
          ]
        : [],
    );
    asks.push(...found);
    open = event.queued ? [...open, ...found] : found;
  }
  return asks;
}

function senderOf(message: Extract<Event, { type: "message" }>): AskSender {
  if (message.origin === "typed") return "person";
  if (message.origin === "scheduled") return "automation";
  return message.sender?.sender ?? "unknown";
}

export const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export function matches(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 1) return words.includes(phrase[0]!);
  const joined = phrase.join("");
  for (let i = 0; i < words.length; i++) {
    if (words[i] === joined) return true;
    if (i + phrase.length > words.length) continue;
    const window = words.slice(i, i + phrase.length);
    if (
      window.every((word, j) => close(word, phrase[j]!)) &&
      window.some((word, j) => word === phrase[j])
    )
      return true;
  }
  return false;
}

function close(word: string, target: string): boolean {
  if (word === target) return true;
  if (word.length < 3 || target.length < 3) return false;
  return (
    distance(word, target) <= 1 ||
    (Math.abs(word.length - target.length) <= 2 && soundex(word) === soundex(target))
  );
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

const CODES: Record<string, string> = Object.fromEntries(
  Array.from("bfpvcgjkqsxzdtlmnr", (letter, i) => [letter, "111122222222334556"[i]!]),
);

function soundex(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word;
  let code = word[0]!;
  let last = CODES[word[0]!] ?? "";
  for (const letter of word.slice(1)) {
    const digit = CODES[letter] ?? "";
    if (digit && digit !== last) code += digit;
    if (letter !== "h" && letter !== "w") last = digit;
  }
  return (code + "000").slice(0, 4);
}
