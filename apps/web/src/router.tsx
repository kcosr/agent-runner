import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RunsDashboardRoute } from "./routes/runs-dashboard.js";

function RootLayout() {
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <RunsDashboardRoute />,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: () => <RunsDashboardRoute />,
});

const routeTree = rootRoute.addChildren([boardRoute, runDetailRoute]);

export const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
