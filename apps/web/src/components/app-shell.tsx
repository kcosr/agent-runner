import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDashboardPreferences } from "../lib/settings.js";
import { FileIcon, GridIcon, SettingsIcon } from "./icons.js";

function PrimaryNavButtons({
  activeSection,
  creatingRun,
  navigate,
}: {
  activeSection: "runs" | "settings";
  creatingRun: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <>
      <button
        aria-current={activeSection === "runs" && !creatingRun ? "page" : undefined}
        className={activeSection === "runs" && !creatingRun ? "nav-item active" : "nav-item"}
        onClick={() => void navigate({ to: "/" })}
        title="Runs"
        type="button"
      >
        <GridIcon aria-hidden="true" />
      </button>
      <button
        aria-current={creatingRun ? "page" : undefined}
        className={creatingRun ? "nav-item active" : "nav-item"}
        onClick={() => void navigate({ to: "/runs/new" })}
        title="New Run"
        type="button"
      >
        <FileIcon aria-hidden="true" />
      </button>
      <button
        aria-current={activeSection === "settings" ? "page" : undefined}
        className={activeSection === "settings" ? "nav-item active" : "nav-item"}
        onClick={() => void navigate({ to: "/settings/general" })}
        title="Settings"
        type="button"
      >
        <SettingsIcon aria-hidden="true" />
      </button>
    </>
  );
}

export function TopbarPrimaryNav() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeSection = pathname.startsWith("/settings") ? "settings" : "runs";
  const creatingRun = pathname === "/runs/new";

  return (
    <div aria-label="Primary navigation" className="mobile-topbar-nav">
      <PrimaryNavButtons
        activeSection={activeSection}
        creatingRun={creatingRun}
        navigate={navigate}
      />
    </div>
  );
}

export function AppShell({
  topNotices,
  bottomNotices,
  toolbar,
  primary,
  secondary,
}: {
  topNotices?: ReactNode;
  bottomNotices?: ReactNode;
  toolbar: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
}) {
  const navigate = useNavigate();
  const { preferences } = useDashboardPreferences();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeSection = pathname.startsWith("/settings") ? "settings" : "runs";
  const creatingRun = pathname === "/runs/new";

  return (
    <div className="app" data-focus-indicators={preferences.visibleFocusIndicators ? "on" : "off"}>
      <div className="shell">
        <aside aria-label="Primary navigation" className="sidebar">
          <span aria-label="agent-runner" className="brand-mark">
            ar
          </span>
          <PrimaryNavButtons
            activeSection={activeSection}
            creatingRun={creatingRun}
            navigate={navigate}
          />
          <span className="nav-spacer" />
        </aside>
        <div className="main">
          {toolbar}
          {topNotices ? <div className="notice-stack">{topNotices}</div> : null}
          <main className="layout">
            {primary}
            {secondary}
          </main>
          {bottomNotices ? (
            <div className="notice-stack notice-stack--bottom">{bottomNotices}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
