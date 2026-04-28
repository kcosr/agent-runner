import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useRef, useState } from "react";
import {
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  type DashboardViewState,
  useDashboardViewState,
} from "./settings.js";
import type { DrawerResize } from "./use-drawer-resize.js";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

function clampChatWidth(value: number): number {
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(value)));
}

export function useChatResize(): DrawerResize {
  const { viewState, updateViewState } = useDashboardViewState();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const width = clampChatWidth(dragWidth ?? viewState.chatWidth);

  function setChatWidth(chatWidth: DashboardViewState["chatWidth"]) {
    updateViewState({ chatWidth });
  }

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
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
    setDragWidth(clampChatWidth(drag.startWidth + (drag.startX - event.clientX)));
  }

  function handleResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 10;
    let next: number | null = null;
    if (event.key === "ArrowLeft") {
      next = clampChatWidth(width + step);
    } else if (event.key === "ArrowRight") {
      next = clampChatWidth(width - step);
    } else if (event.key === "Home") {
      next = CHAT_WIDTH_MIN;
    } else if (event.key === "End") {
      next = CHAT_WIDTH_MAX;
    }
    if (next !== null) {
      event.preventDefault();
      setChatWidth(next);
    }
  }

  function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const final = clampChatWidth(drag.startWidth + (drag.startX - event.clientX));
    dragRef.current = null;
    setDragWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (final !== viewState.chatWidth) {
      setChatWidth(final);
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

  return {
    width,
    dragWidth,
    maxWidth: CHAT_WIDTH_MAX,
    minWidth: CHAT_WIDTH_MIN,
    drawerStyle: { "--chat-width": `${width}px` } as CSSProperties,
    isFullscreen: false,
    toggleFullscreen: () => undefined,
    resizeHandleProps: {
      onPointerDown: handleResizeStart,
      onPointerMove: handleResizeMove,
      onPointerUp: handleResizeEnd,
      onPointerCancel: handleResizeCancel,
      onKeyDown: handleResizeKey,
    },
  };
}
