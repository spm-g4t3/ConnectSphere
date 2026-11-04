// Where ProtectedRoute sends a signed-in user whose role is not allowed.
// There is no admin role, so the Lead is who checks a user's roles.
export default function NotAvailablePage() {
  return (
    <main className="placeholder-page">
      <span className="eyebrow">ConnectSphere workspace</span>
      <h1>Not available to your role</h1>
      <p>
        Your account does not have access to that page. If you think it should,
        ask your Event Coordinator Lead to check your role.
      </p>
    </main>
  );
}
