import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "./components/ui/button.tsx";
import { freshness } from "./housekeeping.ts";

export type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      report: T;
      computedAt: string | null;
      refreshing: boolean;
      refreshError: string | null;
    };

export function useReport<T>(path: string) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const load = useCallback(
    async (refresh = false) => {
      setState((last) => (last.status === "ready" ? last : { status: "loading" }));
      try {
        const response = await fetch(refresh ? `${path}?refresh=1` : path);
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        setState({
          status: "ready",
          report: (await response.json()) as T,
          computedAt: response.headers.get("x-quench-computed-at"),
          refreshing: response.headers.get("x-quench-refreshing") === "true",
          refreshError:
            decodeURIComponent(response.headers.get("x-quench-refresh-error") ?? "") || null,
        });
      } catch (error) {
        setState({ status: "error", message: (error as Error).message });
      }
    },
    [path],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const refreshing = state.status === "ready" && state.refreshing;
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [refreshing, load]);
  return [state, load] as const;
}

export function Loaded<T>({
  path,
  what,
  children,
}: {
  path: string;
  what: string;
  children: (report: T) => ReactNode;
}) {
  const [state, load] = useReport<T>(path);
  if (state.status === "loading")
    return (
      <Message title="Reading your session history…">
        The first scan after quench ui starts can take minutes; later visits show the last result at
        once and refresh in the background.
      </Message>
    );
  if (state.status === "error")
    return (
      <Message title={`Couldn't load ${what}`}>
        <span className="font-mono text-xs">{state.message}</span>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => load()}>
            Try again
          </Button>
        </div>
      </Message>
    );
  return (
    <>
      {state.computedAt && (
        <div className="mb-4 flex items-baseline justify-end gap-2 font-mono text-xs text-muted-foreground">
          {freshness(state.computedAt, state.refreshing, Date.now())}
          <Button
            variant="outline"
            size="sm"
            disabled={state.refreshing}
            onClick={() => load(true)}
          >
            Refresh
          </Button>
        </div>
      )}
      {state.refreshError && (
        <p className="mb-4 font-mono text-xs text-warn">
          Last refresh failed, showing the earlier result: {state.refreshError}
        </p>
      )}
      {children(state.report)}
    </>
  );
}

export function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-1 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
