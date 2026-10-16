export default function SafetyApprovalNotice({ status }) {
  if (status !== "safety_approved") return null;

  return (
    <div className="safety-approval-notice" role="status">
      <span className="safety-approval-notice__check" aria-hidden="true">✓</span>
      <div>
        <strong>Safety approval complete</strong>
        <p>A Safety Officer has approved the event arrangements.</p>
      </div>
    </div>
  );
}
