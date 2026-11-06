export type Route = { tab: string; params: URLSearchParams };

export function parseRoute(hash: string, tabs: readonly string[]): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  return { tab: tabs.includes(path) ? path : tabs[0]!, params: new URLSearchParams(query) };
}

export const href = (tab: string, params: Record<string, string> = {}) => {
  const query = new URLSearchParams(params).toString();
  return `#/${tab}${query ? `?${query}` : ""}`;
};
