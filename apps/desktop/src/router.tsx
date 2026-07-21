import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppLayout } from "./AppLayout";
import { XrayPanel } from "./panels/XrayPanel";
import { MatrixPanel } from "./panels/MatrixPanel";
import { SkillEditorPanel } from "./panels/SkillEditorPanel";

// quench#7: hash history. A Tauri webview serves the frontend from tauri://
// (or file://) where the browser's path-based history has no server to answer
// deep links — hash routing keeps navigation entirely client-side.
const rootRoute = createRootRoute({ component: AppLayout });

const xrayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: XrayPanel,
});

const matrixRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matrix",
  component: MatrixPanel,
});

const skillEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillEditorPanel,
});

const routeTree = rootRoute.addChildren([xrayRoute, matrixRoute, skillEditorRoute]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
