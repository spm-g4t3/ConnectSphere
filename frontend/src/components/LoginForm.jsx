// LoginForm.jsx

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function LoginForm() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await login(email, password);

    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    // Role-based redirect happens automatically via the Dashboard router,
    // so a single redirect target works for all roles.
    navigate("/dashboard");
  }

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <h1>Log in</h1>

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>

      {error && <p className="login-form__error" role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? "Logging in..." : "Log in"}
      </button>
    </form>
  );
}
