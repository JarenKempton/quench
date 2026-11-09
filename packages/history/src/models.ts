const MODEL =
  /\b(?:claude-(?:opus|sonnet|haiku|fable)-\d+(?:[-.]\d+)?(?:-\d{8})?|claude-\d+(?:-\d+)?-(?:opus|sonnet|haiku)(?:-\d{8})?|gpt-\d+(?:\.\d+)?o?(?:-[a-z]+)*|o\d(?:-mini|-pro)?|gemini-\d+(?:\.\d+)?-(?:pro|flash)(?:-[a-z]+)*)\b/g;

export const modelNamesIn = (text: string): string[] => [...new Set(text.match(MODEL) ?? [])];

export const modelFamily = (model: string) => model.replace(/-\d.*$/, "");

export function modelVersion(model: string): number | null {
  const found = /-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(model);
  return found ? Number(`${found[1]}.${found[2] ?? 0}`) : null;
}
