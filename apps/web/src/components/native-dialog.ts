import { type RefObject, useLayoutEffect, useRef } from "react";

export function useNativeModalDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }

      return () => {
        if (dialog.open) {
          dialog.close();
        }
      };
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  return dialogRef;
}
