import type { ReactNode } from "react";
import { FileIcon, GridIcon, SettingsIcon } from "./icons.js";

export function AppShell({
  notices,
  toolbar,
  board,
  detail,
}: {
  notices?: ReactNode;
  toolbar: ReactNode;
  board: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="app">
      <div className="shell">
        <aside aria-label="Primary navigation" className="sidebar">
          <span aria-label="task-runner" className="brand-mark">
            tr
          </span>
          <button aria-current="page" className="nav-item active" title="Runs" type="button">
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
          <button className="nav-item" title="Settings" type="button">
            <SettingsIcon aria-hidden="true" />
          </button>
        </aside>
        <div className="main">
          {toolbar}
          {notices ? <div className="notice-stack">{notices}</div> : null}
          <main className="layout">
            {board}
            {detail}
          </main>
        </div>
      </div>
    </div>
  );
}
