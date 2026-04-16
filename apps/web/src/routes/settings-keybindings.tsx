import { SettingsPage, SettingsSection } from "../components/settings/settings-layout.js";

export function SettingsKeybindingsRoute() {
  return (
    <SettingsPage
      description="Keyboard shortcut editing is planned, but it is not part of this dashboard update."
      title="Keybindings"
    >
      <SettingsSection
        description="This is an intentional placeholder so the settings area can grow without changing the shell structure again."
        title="Coming later"
      >
        <div className="settings-placeholder">
          <p>Configurable keybindings will be added in a later change.</p>
          <p>Escape leaves settings through browser back navigation today.</p>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
