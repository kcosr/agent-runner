import { Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell, TopbarPrimaryNav } from "../components/app-shell.js";
import { SettingsLayout } from "../components/settings/settings-layout.js";
import { SettingsSidebarNav } from "../components/settings/settings-sidebar-nav.js";
import { resolveSettingsShortcutCommand } from "../lib/shortcuts.js";

export function SettingsLayoutRoute() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || resolveSettingsShortcutCommand(event) !== "settings.close") {
        return;
      }
      event.preventDefault();
      void navigate({ to: "/" });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigate]);

  return (
    <AppShell
      primary={
        <SettingsLayout navigation={<SettingsSidebarNav />}>
          <Outlet />
        </SettingsLayout>
      }
      toolbar={
        <header className="topbar">
          <TopbarPrimaryNav />
          <span className="page-title">Settings</span>
          <span className="page-title-meta">Local dashboard preferences</span>
        </header>
      }
    />
  );
}
