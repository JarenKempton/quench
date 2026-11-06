import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { freshness } from "./housekeeping.ts";
import { cn } from "./lib/utils.ts";
import type { State } from "./use-api.ts";

export function Fresh<T>({ state, refresh }: { state: State<T>; refresh: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  if (state.status !== "ready" || !state.computedAt) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
      {freshness(state.computedAt, state.refreshing, now)}
      <Button variant="outline" size="sm" onClick={refresh} disabled={state.refreshing}>
        <RefreshCw className={cn(state.refreshing && "animate-spin")} />
        Refresh
      </Button>
      {state.refreshError && (
        <span role="alert" className="text-warn">
          Last refresh failed, showing the earlier result: {state.refreshError}
        </span>
      )}
    </span>
  );
}
