import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
  type SyntheticEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

type NativeModalDialogProps = {
  "data-modal": "true";
  onCancel: (event: SyntheticEvent<HTMLDialogElement, Event>) => void;
  onClick: (event: ReactMouseEvent<HTMLDialogElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDialogElement>) => void;
};

type NativeModalDialogBindings = {
  ref: RefCallback<HTMLDialogElement>;
  dialogProps: NativeModalDialogProps;
};

export function useNativeModalDialog(
  open: boolean,
  onClose: () => void,
): NativeModalDialogBindings {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const ref = useCallback<RefCallback<HTMLDialogElement>>(
    (dialog) => {
      const previousDialog = dialogRef.current;
      if (previousDialog && previousDialog !== dialog && previousDialog.open) {
        previousDialog.close();
      }

      dialogRef.current = dialog;
      if (dialog && open && !dialog.open) {
        dialog.showModal();
      }
    },
    [open],
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) {
      return;
    }

    if (!dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [open]);

  const dialogProps = useMemo<NativeModalDialogProps>(
    () => ({
      "data-modal": "true",
      onCancel: (event) => {
        event.preventDefault();
        onClose();
      },
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      },
      onKeyDown: (event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClose();
        }
      },
    }),
    [onClose],
  );

  return { dialogProps, ref };
}
