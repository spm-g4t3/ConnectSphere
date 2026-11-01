import "./ui.css";

export default function EmptyState({ message, nextStep, action }) {
  return (
    <div className="ui-empty-state">
      <p className="ui-empty-state__message">{message}</p>
      <p className="ui-empty-state__next-step">{nextStep}</p>
      {action && <div className="ui-empty-state__action">{action}</div>}
    </div>
  );
}
