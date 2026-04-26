import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  value: () => {},
  writable: true,
});

Object.defineProperties(HTMLDialogElement.prototype, {
  close: {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (!this.open) {
        return;
      }
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  },
  showModal: {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (this.open) {
        return;
      }
      this.setAttribute("open", "");
    },
  },
});
