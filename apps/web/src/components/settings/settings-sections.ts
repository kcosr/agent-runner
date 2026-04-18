export const SETTINGS_SECTIONS = [
  {
    description: "Dashboard defaults and board preferences",
    id: "general",
    path: "/settings/general",
    routePath: "general",
    title: "General",
  },
  {
    description: "Current keyboard shortcuts and navigation",
    id: "keybindings",
    path: "/settings/keybindings",
    routePath: "keybindings",
    title: "Keybindings",
  },
] as const;
