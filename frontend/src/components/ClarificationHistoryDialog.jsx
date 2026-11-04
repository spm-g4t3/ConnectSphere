import { useEffect, useRef, useState } from "react";
import ClarificationHistory from "./ClarificationHistory";
import Button from "./ui/Button";

export default function ClarificationHistoryDialog({
  eventRequestId,
  eventName,
  isOpenQuestion = false,
  latestQuestion,
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog || dialog.open) return undefined;

    dialog.showModal();
    closeButtonRef.current?.focus();
    return () => {
      /* v8 ignore next -- @preserve The dialog is always open here; Escape is prevented. */
      if (dialog.open) dialog.close();
    };
  }, [open]);

  function closeDialog() {
    setOpen(false);
  }

  return (
    <>
      <Button
        variant="secondary"
        className="clarification-history__open"
        onClick={() => setOpen(true)}
      >
        {isOpenQuestion ? "View previous messages" : "View clarification history"}
      </Button>
      {open && (
        <dialog
          ref={dialogRef}
          className="clarification-history-dialog"
          aria-labelledby="clarification-history-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            closeDialog();
          }}
          onClick={(event) => {
            if (event.target === dialogRef.current) closeDialog();
          }}
        >
          <div className="clarification-history-dialog__header">
            <div>
              <h2 id="clarification-history-dialog-title">Clarification history</h2>
              {eventName && <p>{eventName}</p>}
            </div>
            <Button
              ref={closeButtonRef}
              variant="secondary"
              className="clarification-history-dialog__close"
              aria-label="Close clarification history"
              onClick={closeDialog}
            >
              Close
            </Button>
          </div>
          <ClarificationHistory
            eventRequestId={eventRequestId}
            isOpen={isOpenQuestion}
            omitLatestQuestionMessage={isOpenQuestion ? latestQuestion : undefined}
          />
        </dialog>
      )}
    </>
  );
}
