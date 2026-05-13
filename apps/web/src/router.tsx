import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { SETTINGS_SECTIONS } from "./components/settings/settings-sections.js";
import { NewRunRoute } from "./routes/new-run-route.js";
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

const newRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/new",
  component: () => <NewRunRoute />,
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
  path: SETTINGS_SECTIONS[0].routePath,
  component: () => <SettingsGeneralRoute />,
});

const settingsKeybindingsRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: SETTINGS_SECTIONS[1].routePath,
  component: () => <SettingsKeybindingsRoute />,
});

const routeTree = rootRoute.addChildren([
  boardRoute,
  newRunRoute,
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
