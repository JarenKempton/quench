import { useCallback, useRef, useState } from "react";

export type State<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: T; computedAt: Date | null; refreshing: boolean };

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
        [path]: was?.status === "ready" ? { ...was, refreshing: true } : { status: "loading" },
      };
    });
    let next: State<unknown>;
    try {
      const response = await fetch(refresh ? `${path}?refresh=1` : path);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const at = response.headers.get("x-quench-computed-at");
      next = {
        status: "ready",
        report: await response.json(),
        computedAt: at ? new Date(at) : null,
        refreshing: false,
      };
    } catch (error) {
      next = { status: "error", message: (error as Error).message };
    }
    setStates((all) => ({ ...all, [path]: next }));
  }, []);
  const ensure = useCallback(
    (path: string) => {
      if (!started.current.has(path)) void load(path);
    },
    [load],
  );
  return { states, load, ensure };
}
