import "./ui.css";

export default function StatusBadge({ tone = "neutral", children }) {
  return <span className={`ui-status-badge ui-status-badge--${tone}`}>{children}</span>;
}
