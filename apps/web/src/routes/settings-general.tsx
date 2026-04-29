import {
  SettingsPage,
  SettingsResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settings-layout.js";
import {
  DEFAULT_DASHBOARD_PREFERENCES,
  type DashboardPreferenceKey,
  type DashboardSortDirection,
  type DashboardSortField,
  useDashboardPreferences,
} from "../lib/settings.js";

type TogglePreferenceKey = Exclude<
  DashboardPreferenceKey,
  "sortDirection" | "sortField" | "structuredFilters"
>;

interface PreferenceRowDefinition {
  description: string;
  key: TogglePreferenceKey;
  title: string;
}

const BOARD_PREFERENCE_ROWS: PreferenceRowDefinition[] = [
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
    key: "showScheduledOnly",
    title: "Show scheduled runs only",
    description:
      "Keep only scheduled runs visible on the board until you turn the filter back off.",
  },
  {
    key: "showPinnedOnly",
    title: "Show pinned runs only",
    description: "Keep only pinned runs visible on the board until you turn the filter back off.",
  },
];

const SORT_FIELD_OPTIONS: { label: string; value: DashboardSortField }[] = [
  { label: "Started time", value: "startedAt" },
  { label: "Last updated", value: "updatedAt" },
  { label: "Ended time", value: "endedAt" },
];

const SORT_DIRECTION_OPTIONS: { label: string; value: DashboardSortDirection }[] = [
  { label: "Newest first", value: "desc" },
  { label: "Oldest first", value: "asc" },
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

  const allDefaults =
    preferenceRows.every(({ key }) => preferences[key] === DEFAULT_DASHBOARD_PREFERENCES[key]) &&
    preferences.sortField === DEFAULT_DASHBOARD_PREFERENCES.sortField &&
    preferences.sortDirection === DEFAULT_DASHBOARD_PREFERENCES.sortDirection;

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
        <SettingsRow
          action={
            <SettingsResetButton
              disabled={preferences.sortField === DEFAULT_DASHBOARD_PREFERENCES.sortField}
              onClick={() => resetPreference("sortField")}
              settingLabel="Board sort field"
            />
          }
          control={
            <select
              aria-label="Board sort field"
              className="settings-select"
              onChange={(event) =>
                updatePreferences({ sortField: event.target.value as DashboardSortField })
              }
              value={preferences.sortField}
            >
              {SORT_FIELD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          }
          description="Choose the timestamp used to order runs within every board column."
          title="Board sort field"
        />
        <SettingsRow
          action={
            <SettingsResetButton
              disabled={preferences.sortDirection === DEFAULT_DASHBOARD_PREFERENCES.sortDirection}
              onClick={() => resetPreference("sortDirection")}
              settingLabel="Board sort direction"
            />
          }
          control={
            <select
              aria-label="Board sort direction"
              className="settings-select"
              onChange={(event) =>
                updatePreferences({
                  sortDirection: event.target.value as DashboardSortDirection,
                })
              }
              value={preferences.sortDirection}
            >
              {SORT_DIRECTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          }
          description="Choose whether the selected board timestamp is sorted newest-first or oldest-first."
          title="Board sort direction"
        />
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
