import { useEffect, useId, useRef } from "react";
import Button from "./Button";
import "./ui.css";

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // The dialog is rendered whenever open is true, so the ref is set here.
    const dialog = dialogRef.current;
    dialog.showModal();
    // Focus starts on Cancel so a stray Enter never confirms a destructive action.
    cancelButtonRef.current.focus();
    return () => dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="ui-confirm-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        // While the action is in flight, Escape is held like the disabled buttons.
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className="ui-confirm-dialog__title">
        {title}
      </h2>
      <div className="ui-confirm-dialog__message">{children}</div>
      <div className="ui-confirm-dialog__actions">
        <Button
          ref={cancelButtonRef}
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
