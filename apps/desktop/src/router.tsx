import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppLayout } from "./AppLayout";
import { ContextPanel } from "./panels/ContextPanel";

const rootRoute = createRootRoute({ component: AppLayout });

const contextRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ContextPanel,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([contextRoute]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
