import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RunsDashboardRoute } from "./routes/runs-dashboard.js";
import { SettingsGeneralRoute } from "./routes/settings-general.js";
import { SettingsKeybindingsRoute } from "./routes/settings-keybindings.js";
import { SettingsLayoutRoute } from "./routes/settings-layout.js";

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

const settingsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => <SettingsLayoutRoute />,
});

const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: "general",
  component: () => <SettingsGeneralRoute />,
});

const settingsKeybindingsRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: "keybindings",
  component: () => <SettingsKeybindingsRoute />,
});

const routeTree = rootRoute.addChildren([
  boardRoute,
  runDetailRoute,
  settingsLayoutRoute.addChildren([settingsGeneralRoute, settingsKeybindingsRoute]),
]);

export const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
