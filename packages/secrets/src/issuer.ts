const HOST = /\bhttps?:\/\/(?:[^\s/@'"]+@)?([\w.-]+)/i;

export function issuerOf(rule: string, value: string, context: string): string | null {
  if (rule === "jwt") return claim(value);
  if (rule === "jwt-base64") return claim(Buffer.from(value, "base64").toString());
  if (rule.startsWith("curl-auth")) return HOST.exec(context)?.[1]?.toLowerCase() ?? null;
  return null;
}

export const printable = (text: string): string | null =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 200) || null;

function claim(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const { iss } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: unknown };
    return typeof iss === "string" ? printable(iss) : null;
  } catch {
    return null;
  }
}
