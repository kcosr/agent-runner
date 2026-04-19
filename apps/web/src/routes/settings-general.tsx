import {
  SettingsPage,
  SettingsResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settings-layout.js";
import {
  DEFAULT_DASHBOARD_PREFERENCES,
  type DashboardPreferenceKey,
  useDashboardPreferences,
} from "../lib/settings.js";

type TogglePreferenceKey = Exclude<DashboardPreferenceKey, "structuredFilters">;

interface PreferenceRowDefinition {
  description: string;
  key: TogglePreferenceKey;
  title: string;
}

const BOARD_PREFERENCE_ROWS: PreferenceRowDefinition[] = [
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
    key: "showPinnedOnly",
    title: "Show pinned runs only",
    description: "Keep only pinned runs visible on the board until you turn the filter back off.",
  },
  {
    key: "sortByRecentUpdates",
    title: "Sort by recent updates",
    description:
      "Promote touched runs to the top of their columns instead of keeping the board in pure started-time order. The touched-run ordering is in-memory only and resets on page restart.",
  },
];

const DISPLAY_PREFERENCE_ROWS: PreferenceRowDefinition[] = [
  {
    key: "visibleFocusIndicators",
    title: "Visible focus indicators",
    description:
      "Show the dashboard's current focus rings and highlight states without changing keyboard navigation or focus movement.",
  },
];

export function SettingsGeneralRoute() {
  const { preferences, resetPreference, resetPreferences, updatePreferences } =
    useDashboardPreferences();
  const preferenceRows = [...BOARD_PREFERENCE_ROWS, ...DISPLAY_PREFERENCE_ROWS];

  const allDefaults = preferenceRows.every(
    ({ key }) => preferences[key] === DEFAULT_DASHBOARD_PREFERENCES[key],
  );

  function renderPreferenceRow({ description, key, title }: PreferenceRowDefinition) {
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
  }

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
        {BOARD_PREFERENCE_ROWS.map(renderPreferenceRow)}
      </SettingsSection>
      <SettingsSection
        description="Persisted dashboard display preferences that apply across the app shell."
        title="Display preferences"
      >
        {DISPLAY_PREFERENCE_ROWS.map(renderPreferenceRow)}
      </SettingsSection>
    </SettingsPage>
  );
}
