import { useNavigate, useRouterState } from "@tanstack/react-router";

const SETTINGS_SECTIONS = [
  {
    description: "Dashboard defaults and board preferences",
    id: "general",
    path: "/settings/general",
    title: "General",
  },
  {
    description: "Configurable shortcuts placeholder",
    id: "keybindings",
    path: "/settings/keybindings",
    title: "Keybindings",
  },
] as const;

export function SettingsSidebarNav() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <nav aria-label="Settings sections" className="settings-sidebar-nav">
      <div className="settings-sidebar-nav__header">
        <p className="settings-sidebar-nav__eyebrow">Settings</p>
        <h2>Sections</h2>
      </div>
      <div className="settings-sidebar-nav__list">
        {SETTINGS_SECTIONS.map((section) => {
          const isActive = pathname === section.path;
          return (
            <button
              aria-describedby={`settings-section-description-${section.id}`}
              aria-current={isActive ? "page" : undefined}
              aria-label={section.title}
              className={
                isActive ? "settings-sidebar-nav__item active" : "settings-sidebar-nav__item"
              }
              key={section.id}
              onClick={() => void navigate({ to: section.path })}
              type="button"
            >
              <span className="settings-sidebar-nav__title">{section.title}</span>
              <span
                className="settings-sidebar-nav__description"
                id={`settings-section-description-${section.id}`}
              >
                {section.description}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
