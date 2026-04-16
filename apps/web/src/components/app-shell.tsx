import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FileIcon, GridIcon, SettingsIcon } from "./icons.js";

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
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeSection = pathname.startsWith("/settings") ? "settings" : "runs";

  return (
    <div className="app">
      <div className="shell">
        <aside aria-label="Primary navigation" className="sidebar">
          <span aria-label="task-runner" className="brand-mark">
            tr
          </span>
          <button
            aria-current={activeSection === "runs" ? "page" : undefined}
            className={activeSection === "runs" ? "nav-item active" : "nav-item"}
            onClick={() => void navigate({ to: "/" })}
            title="Runs"
            type="button"
          >
            <GridIcon aria-hidden="true" />
          </button>
          <button
            aria-disabled="true"
            className="nav-item"
            disabled
            title="Definitions (deferred in phase 1)"
            type="button"
          >
            <FileIcon aria-hidden="true" />
          </button>
          <span className="nav-spacer" />
          <button
            aria-current={activeSection === "settings" ? "page" : undefined}
            className={activeSection === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => void navigate({ to: "/settings/general" })}
            title="Settings"
            type="button"
          >
            <SettingsIcon aria-hidden="true" />
          </button>
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
