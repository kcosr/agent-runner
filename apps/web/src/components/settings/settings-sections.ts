export const SETTINGS_SECTIONS = [
  {
    description: "Dashboard defaults and board preferences",
    id: "general",
    path: "/settings/general",
    routePath: "general",
    title: "General",
  },
  {
    description: "Configurable shortcuts placeholder",
    id: "keybindings",
    path: "/settings/keybindings",
    routePath: "keybindings",
    title: "Keybindings",
  },
] as const;
