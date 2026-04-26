import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeModalDialog } from "./native-dialog.js";

function TestDialog({ onClose }: { onClose: () => void }) {
  const { dialogProps, ref } = useNativeModalDialog(true, onClose);

  return (
    <dialog aria-label="Native modal" {...dialogProps} ref={ref}>
      <button type="button">Inside</button>
    </dialog>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useNativeModalDialog", () => {
  it("opens mounted dialogs modally and closes them on unmount", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");

    const { unmount } = render(<TestDialog onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Native modal" })).toHaveAttribute("open");
    expect(showModal).toHaveBeenCalledTimes(1);

    unmount();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("binds native cancel and backdrop close triggers to onClose", () => {
    const onClose = vi.fn();
    render(<TestDialog onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Native modal" });
    const insideButton = within(dialog).getByRole("button", { name: "Inside" });

    fireEvent.click(insideButton);
    fireEvent.keyDown(insideButton, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);

    const cancelEvent = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancelEvent);

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.keyDown(dialog, { key: " " });

    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
