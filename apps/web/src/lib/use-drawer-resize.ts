import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { DRAWER_WIDTH_MIN, computeDrawerMaxWidth, useBoardSettings } from "./settings.js";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

function readViewportWidth(): number {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}

export interface DrawerResize {
  width: number;
  dragWidth: number | null;
  maxWidth: number;
  minWidth: number;
  drawerStyle: CSSProperties;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  resizeHandleProps: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  };
}

export function useDrawerResize(): DrawerResize {
  const { settings, updateSettings } = useBoardSettings();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [maxWidth, setMaxWidth] = useState(() => computeDrawerMaxWidth(readViewportWidth()));

  useEffect(() => {
    function onResize() {
      setMaxWidth(computeDrawerMaxWidth(readViewportWidth()));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isFullscreen = settings.drawerFullscreen;
  const storedWidth = settings.drawerWidth;
  const width = isFullscreen ? maxWidth : clamp(dragWidth ?? storedWidth);
  const drawerStyle = { "--drawer-width": `${width}px` } as CSSProperties;

  function clamp(value: number): number {
    return Math.min(maxWidth, Math.max(DRAWER_WIDTH_MIN, Math.round(value)));
  }

  useEffect(() => {
    if (dragWidth !== null && dragWidth > maxWidth) {
      setDragWidth(maxWidth);
    }
  }, [dragWidth, maxWidth]);

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
    if (isFullscreen) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
  }

  function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setDragWidth(clamp(drag.startWidth + (drag.startX - event.clientX)));
  }

  function handleResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (isFullscreen) return;
    const step = event.shiftKey ? 40 : 10;
    let next: number | null = null;
    if (event.key === "ArrowLeft") {
      next = clamp(width + step);
    } else if (event.key === "ArrowRight") {
      next = clamp(width - step);
    } else if (event.key === "Home") {
      next = DRAWER_WIDTH_MIN;
    } else if (event.key === "End") {
      next = maxWidth;
    }
    if (next !== null) {
      event.preventDefault();
      updateSettings({ drawerWidth: next });
    }
  }

  function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const final = clamp(drag.startWidth + (drag.startX - event.clientX));
    dragRef.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (final !== settings.drawerWidth) {
      updateSettings({ drawerWidth: final });
    }
  }

  function handleResizeCancel(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function toggleFullscreen() {
    updateSettings({ drawerFullscreen: !isFullscreen });
  }

  return {
    width,
    dragWidth,
    maxWidth,
    minWidth: DRAWER_WIDTH_MIN,
    drawerStyle,
    isFullscreen,
    toggleFullscreen,
    resizeHandleProps: {
      onPointerDown: handleResizeStart,
      onPointerMove: handleResizeMove,
      onPointerUp: handleResizeEnd,
      onPointerCancel: handleResizeCancel,
      onKeyDown: handleResizeKey,
    },
  };
}
