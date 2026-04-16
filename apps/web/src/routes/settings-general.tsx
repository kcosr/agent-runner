import {
  SettingsPage,
  SettingsResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settings-layout.js";
import { DEFAULT_DASHBOARD_PREFERENCES, useDashboardPreferences } from "../lib/settings.js";

interface PreferenceRowDefinition {
  description: string;
  key: keyof typeof DEFAULT_DASHBOARD_PREFERENCES;
  title: string;
}

const PREFERENCE_ROWS: PreferenceRowDefinition[] = [
  {
    key: "hideEmptyColumns",
    title: "Hide empty columns",
    description: "Keep board columns with no visible runs out of the main board by default.",
  },
  {
    key: "collapseFailureStates",
    title: "Collapse failure states",
    description: "Group exhausted and error runs into one Failed column on the board.",
  },
  {
    key: "showArchived",
    title: "Show archived runs",
    description: "Include archived runs in the board and counts until you hide them again.",
  },
  {
    key: "sortByRecentUpdates",
    title: "Sort by recent updates",
    description:
      "Promote touched runs to the top of their columns instead of keeping the board in pure started-time order. The touched-run ordering is in-memory only and resets on page restart.",
  },
];

export function SettingsGeneralRoute() {
  const { preferences, resetPreference, resetPreferences, updatePreferences } =
    useDashboardPreferences();

  const allDefaults = PREFERENCE_ROWS.every(
    ({ key }) => preferences[key] === DEFAULT_DASHBOARD_PREFERENCES[key],
  );

  return (
    <SettingsPage
      actions={
        <button className="btn" disabled={allDefaults} onClick={resetPreferences} type="button">
          Restore defaults
        </button>
      }
      description="These local settings stay in sync with the remaining quick toggles in the runs toolbar."
      title="General"
    >
      <SettingsSection
        description="Persisted dashboard preferences that shape how the runs board appears by default."
        title="Board preferences"
      >
        {PREFERENCE_ROWS.map(({ description, key, title }) => {
          const checked = preferences[key];
          const isDefault = checked === DEFAULT_DASHBOARD_PREFERENCES[key];

          return (
            <SettingsRow
              action={
                <SettingsResetButton
                  disabled={isDefault}
                  onClick={() => resetPreference(key)}
                  settingLabel={title}
                />
              }
              control={
                <label className="settings-toggle">
                  <input
                    aria-label={title}
                    checked={checked}
                    onChange={(event) => updatePreferences({ [key]: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{checked ? "On" : "Off"}</span>
                </label>
              }
              description={description}
              key={key}
              title={title}
            />
          );
        })}
      </SettingsSection>
    </SettingsPage>
  );
}
