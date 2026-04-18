import { KeyIcon } from "../components/icons.js";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settings-layout.js";

type ShortcutDefinition = {
  description: string;
  keys: readonly string[];
  macKeys?: readonly string[];
  title: string;
};

type ShortcutSection = {
  description: string;
  shortcuts: readonly ShortcutDefinition[];
  title: string;
};

const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    description:
      "Available while the dashboard is visible and the detail drawer is not fullscreen.",
    shortcuts: [
      {
        description: "Move selection between runs on the board.",
        keys: ["Arrow Up", "Arrow Down", "Arrow Left", "Arrow Right"],
        title: "Navigate runs",
      },
      {
        description: "Focus the run search field.",
        keys: ["Ctrl", "F"],
        macKeys: ["Cmd", "F"],
        title: "Focus search",
      },
      {
        description: "Blur the focused search field and keep the current query.",
        keys: ["Enter"],
        title: "Exit search focus",
      },
      {
        description: "Trigger the selected run's primary action when one is available.",
        keys: ["Enter"],
        title: "Run primary action",
      },
      {
        description:
          "Toggle the selected detail drawer or attachment preview between normal and fullscreen widths.",
        keys: ["F"],
        title: "Toggle drawer fullscreen",
      },
      {
        description:
          "Clear the focused search when it has text, then blur it on a second press. When the drawer is fullscreen, exit fullscreen first. Otherwise close attachment preview or selected run detail.",
        keys: ["Escape"],
        title: "Back or close",
      },
    ],
    title: "Dashboard shortcuts",
  },
  {
    description: "Only active while the attachment preview itself is fullscreen.",
    shortcuts: [
      {
        description: "Open the previous attachment in the current preview list.",
        keys: ["Arrow Left"],
        title: "Previous attachment",
      },
      {
        description: "Open the next attachment in the current preview list.",
        keys: ["Arrow Right"],
        title: "Next attachment",
      },
    ],
    title: "Fullscreen attachment preview",
  },
  {
    description: "Available while browsing settings.",
    shortcuts: [
      {
        description: "Leave settings and return to the dashboard.",
        keys: ["Escape"],
        title: "Close settings",
      },
    ],
    title: "Settings",
  },
];

function ShortcutKeys({
  keys,
  macKeys,
}: {
  keys: readonly string[];
  macKeys?: readonly string[];
}) {
  return (
    <div className="settings-shortcut-keys">
      <span aria-hidden="true" className="settings-shortcut-key-icon">
        <KeyIcon />
      </span>
      <div className="settings-shortcut-key-groups">
        <div aria-label={`Shortcut: ${keys.join(" + ")}`} className="settings-shortcut-key-group">
          {keys.map((key) => (
            <kbd key={key} className="settings-shortcut-keycap">
              {key}
            </kbd>
          ))}
        </div>
        {macKeys ? (
          <div
            aria-label={`Mac shortcut: ${macKeys.join(" + ")}`}
            className="settings-shortcut-key-group settings-shortcut-key-group--secondary"
          >
            {macKeys.map((key) => (
              <kbd key={key} className="settings-shortcut-keycap">
                {key}
              </kbd>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsKeybindingsRoute() {
  return (
    <SettingsPage
      description="These shortcuts are fixed for now. When configurable bindings exist, this page can grow from the same layout."
      title="Keybindings"
    >
      {SHORTCUT_SECTIONS.map((section) => (
        <SettingsSection
          description={section.description}
          key={section.title}
          title={section.title}
        >
          {section.shortcuts.map((shortcut) => (
            <SettingsRow
              control={<ShortcutKeys keys={shortcut.keys} macKeys={shortcut.macKeys} />}
              description={shortcut.description}
              key={shortcut.title}
              title={shortcut.title}
            />
          ))}
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}
