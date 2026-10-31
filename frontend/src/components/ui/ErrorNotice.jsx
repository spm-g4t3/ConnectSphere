import Button from "./Button";
import "./ui.css";

export default function ErrorNotice({ message, onRetry }) {
  return (
    <div role="alert" className="ui-error-notice">
      <p className="ui-error-notice__message">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
