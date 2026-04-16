import type { RefObject } from "react";
import { useEffect } from "react";

function hasHorizontalOverflow(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1;
}

function nearestHorizontalScrollTarget(
  boundary: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  let current = target instanceof HTMLElement ? target : boundary;
  while (current && current !== boundary) {
    if (hasHorizontalOverflow(current)) {
      return current;
    }
    current = current.parentElement ?? boundary;
  }
  return hasHorizontalOverflow(boundary) ? boundary : null;
}

export function useHorizontalWheelGuard(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const boundary: HTMLElement = element;

    function handleWheel(event: WheelEvent) {
      if (event.defaultPrevented) {
        return;
      }
      if (Math.abs(event.deltaX) < 4 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
        return;
      }

      const scrollTarget = nearestHorizontalScrollTarget(boundary, event.target);
      if (scrollTarget) {
        scrollTarget.scrollLeft += event.deltaX;
      }

      event.preventDefault();
    }

    boundary.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      boundary.removeEventListener("wheel", handleWheel);
    };
  });
}
