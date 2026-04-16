import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "../components/app-shell.js";
import { SettingsLayout } from "../components/settings/settings-layout.js";
import { SettingsSidebarNav } from "../components/settings/settings-sidebar-nav.js";

export function SettingsLayoutRoute() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }
      window.history.back();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <AppShell
      board={
        <SettingsLayout navigation={<SettingsSidebarNav />}>
          <Outlet />
        </SettingsLayout>
      }
      toolbar={
        <header className="topbar">
          <span className="page-title">Settings</span>
          <span className="page-title-meta">Local dashboard preferences</span>
        </header>
      }
    />
  );
}
