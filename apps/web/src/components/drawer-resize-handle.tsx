import type { DrawerResize } from "../lib/use-drawer-resize.js";

export function DrawerResizeHandle({
  label,
  resize,
}: {
  label: string;
  resize: DrawerResize;
}) {
  if (resize.isFullscreen) {
    return null;
  }
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={resize.maxWidth}
      aria-valuemin={resize.minWidth}
      aria-valuenow={resize.width}
      className={resize.dragWidth !== null ? "drawer-resize active" : "drawer-resize"}
      role="separator"
      tabIndex={0}
      {...resize.resizeHandleProps}
    />
  );
}
