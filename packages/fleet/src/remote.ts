export function normaliseRemote(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  const parsed = scp ? null : URL.parse(trimmed);
  const host = scp ? scp[1] : parsed?.host;
  const path = scp ? scp[2] : parsed?.pathname;
  if (!host || !path) return null;
  const parts = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  if (!parts.length) return null;
  return [host, ...parts].join("/").toLowerCase();
}
