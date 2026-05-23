function eventPathContainsSelector(event: KeyboardEvent, selector: string): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof Element && target.matches(selector));
}

function findEventPathElement<T extends Element>(
  event: KeyboardEvent,
  predicate: (element: Element) => element is T,
): T | null {
  for (const target of event.composedPath()) {
    if (target instanceof Element && predicate(target)) {
      return target;
    }
  }
  return null;
}

function getActiveDiffsFileTreeSearchInput(): HTMLInputElement | null {
  for (const tree of document.querySelectorAll(".diffs-file-tree")) {
    const input = tree.shadowRoot?.querySelector("[data-file-tree-search-input]");
    if (input instanceof HTMLInputElement && tree.shadowRoot?.activeElement === input) {
      return input;
    }
    const lightDomInput = tree.querySelector("[data-file-tree-search-input]");
    if (lightDomInput instanceof HTMLInputElement && document.activeElement === lightDomInput) {
      return lightDomInput;
    }
  }
  return null;
}

export function getActiveDiffsFileTreeElement(): HTMLElement | null {
  for (const tree of document.querySelectorAll(".diffs-file-tree")) {
    const shadowActiveElement = tree.shadowRoot?.activeElement;
    if (
      shadowActiveElement instanceof HTMLElement &&
      !shadowActiveElement.matches("[data-file-tree-search-input]")
    ) {
      return shadowActiveElement;
    }
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      (document.activeElement === tree || tree.contains(document.activeElement)) &&
      !document.activeElement.matches("[data-file-tree-search-input]")
    ) {
      return document.activeElement;
    }
  }
  return null;
}

export function getDiffsFileTreeSearchInput(event: KeyboardEvent): HTMLInputElement | null {
  const input = findEventPathElement(
    event,
    (element): element is HTMLInputElement =>
      element instanceof HTMLInputElement && element.matches("[data-file-tree-search-input]"),
  );
  if (input && eventPathContainsSelector(event, ".diffs-file-tree")) {
    return input;
  }
  return getActiveDiffsFileTreeSearchInput();
}
