import { useCallback, useRef, useState } from "react";

export type State<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      report: T;
      computedAt: string | null;
      refreshing: boolean;
      refreshError: string | null;
    };

export type Outcome<T> =
  | { report: T; computedAt: string | null; refreshing: boolean; refreshError: string | null }
  | { error: string };

export function settled<T>(was: State<T> | undefined, outcome: Outcome<T>): State<T> {
  if (!("error" in outcome)) return { status: "ready", ...outcome };
  if (was?.status === "ready") return { ...was, refreshing: false, refreshError: outcome.error };
  return { status: "error", message: outcome.error };
}

export type Load = (path: string, refresh?: boolean) => Promise<void>;

const POLL_MS = 5000;

export function useApis() {
  const [states, setStates] = useState<Record<string, State<unknown>>>({});
  const started = useRef(new Set<string>());
  const polling = useRef(new Set<string>());
  const load = useCallback<Load>(async (path, refresh = false) => {
    started.current.add(path);
    setStates((all) => {
      const was = all[path];
      return {
        ...all,
        [path]:
          was?.status === "ready"
            ? { ...was, refreshing: refresh || was.refreshing }
            : { status: "loading" },
      };
    });
    let outcome: Outcome<unknown>;
    try {
      const response = await fetch(refresh ? `${path}?refresh=1` : path);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      outcome = {
        report: await response.json(),
        computedAt: response.headers.get("x-quench-computed-at"),
        refreshing: response.headers.get("x-quench-refreshing") === "true",
        refreshError:
          decodeURIComponent(response.headers.get("x-quench-refresh-error") ?? "") || null,
      };
    } catch (error) {
      outcome = { error: (error as Error).message };
    }
    setStates((all) => ({ ...all, [path]: settled(all[path], outcome) }));
    if ("refreshing" in outcome && outcome.refreshing && !polling.current.has(path)) {
      polling.current.add(path);
      setTimeout(() => {
        polling.current.delete(path);
        void load(path);
      }, POLL_MS);
    }
  }, []);
  const ensure = useCallback(
    (path: string) => {
      if (!started.current.has(path)) void load(path);
    },
    [load],
  );
  return { states, load, ensure };
}
