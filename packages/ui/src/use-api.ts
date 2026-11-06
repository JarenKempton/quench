import { useCallback, useRef, useState } from "react";

export type State<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      report: T;
      computedAt: Date | null;
      refreshing: boolean;
      error: string | null;
    };

export type Outcome<T> = { report: T; computedAt: Date | null } | { error: string };

export function settled<T>(was: State<T> | undefined, outcome: Outcome<T>): State<T> {
  if (!("error" in outcome)) return { status: "ready", ...outcome, refreshing: false, error: null };
  if (was?.status === "ready") return { ...was, refreshing: false, error: outcome.error };
  return { status: "error", message: outcome.error };
}

export type Load = (path: string, refresh?: boolean) => Promise<void>;

export function useApis() {
  const [states, setStates] = useState<Record<string, State<unknown>>>({});
  const started = useRef(new Set<string>());
  const load = useCallback<Load>(async (path, refresh = false) => {
    started.current.add(path);
    setStates((all) => {
      const was = all[path];
      return {
        ...all,
        [path]:
          was?.status === "ready"
            ? { ...was, refreshing: true, error: null }
            : { status: "loading" },
      };
    });
    let outcome: Outcome<unknown>;
    try {
      const response = await fetch(refresh ? `${path}?refresh=1` : path);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const at = response.headers.get("x-quench-computed-at");
      outcome = { report: await response.json(), computedAt: at ? new Date(at) : null };
    } catch (error) {
      outcome = { error: (error as Error).message };
    }
    setStates((all) => ({ ...all, [path]: settled(all[path], outcome) }));
  }, []);
  const ensure = useCallback(
    (path: string) => {
      if (!started.current.has(path)) void load(path);
    },
    [load],
  );
  return { states, load, ensure };
}
