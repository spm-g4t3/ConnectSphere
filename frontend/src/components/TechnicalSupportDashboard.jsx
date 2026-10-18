// TechnicalSupportDashboard.jsx

import { useEffect, useState } from "react";
import { getOpenTickets } from "../services/supportService";
import EquipmentRequestQueue from "./EquipmentRequestQueue";
import NotificationInbox from "./NotificationInbox";

export default function TechnicalSupportDashboard({ user }) {
  const [tickets, setTickets] = useState([]);

  useEffect(() => {
    getOpenTickets().then(setTickets);
  }, []);

  return (
    <div className="dashboard dashboard--tech-support">
      <h1>Welcome, {user.name ?? user.email}</h1>

      <section>
        <h2>Open support tickets</h2>
        <ul>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              {ticket.subject} — {ticket.priority} priority
              <button>View</button>
            </li>
          ))}
          {tickets.length === 0 && <p>No open tickets.</p>}
        </ul>
      </section>

      {/* Renders its own <section>s, so each is a direct child of .dashboard and gets the card styling. */}
      <EquipmentRequestQueue />

      <NotificationInbox />
    </div>
  );
}
