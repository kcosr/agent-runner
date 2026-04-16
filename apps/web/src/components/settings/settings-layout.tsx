import type { ReactNode } from "react";

export function SettingsLayout({
  children,
  navigation,
}: {
  children: ReactNode;
  navigation: ReactNode;
}) {
  return (
    <section className="settings-shell">
      <div className="settings-shell__sidebar">{navigation}</div>
      <div className="settings-shell__content">{children}</div>
    </section>
  );
}

export function SettingsPage({
  actions,
  children,
  description,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <div className="settings-page">
      <header className="settings-page__header">
        <div>
          <p className="settings-page__eyebrow">Dashboard settings</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {actions ? <div className="settings-page__actions">{actions}</div> : null}
      </header>
      <div className="settings-page__body">{children}</div>
    </div>
  );
}

export function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

export function SettingsRow({
  action,
  control,
  description,
  title,
}: {
  action?: ReactNode;
  control: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__body">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-row__actions">
        {action}
        {control}
      </div>
    </div>
  );
}

export function SettingsResetButton({
  disabled = false,
  onClick,
  settingLabel,
}: {
  disabled?: boolean;
  onClick: () => void;
  settingLabel: string;
}) {
  return (
    <button
      aria-label={`Reset ${settingLabel} to default`}
      className="btn settings-reset-btn"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      Reset
    </button>
  );
}
