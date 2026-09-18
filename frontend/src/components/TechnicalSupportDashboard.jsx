// TechnicalSupportDashboard.jsx

import { useEffect, useState } from "react";
import { getOpenTickets, getEquipmentRequests } from "../services/supportService";

export default function TechnicalSupportDashboard({ user }) {
  const [tickets, setTickets] = useState([]);
  const [equipmentRequests, setEquipmentRequests] = useState([]);

  useEffect(() => {
    getOpenTickets().then(setTickets);
    getEquipmentRequests().then(setEquipmentRequests);
  }, []);

  return (
    <div className="dashboard dashboard--tech-support">
      <h1>Welcome, {user.name}</h1>

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

      <section>
        <h2>Equipment requests</h2>
        <ul>
          {equipmentRequests.map((req) => (
            <li key={req.id}>
              {req.equipmentName} — for {req.eventName}
              <button>Mark fulfilled</button>
            </li>
          ))}
          {equipmentRequests.length === 0 && <p>No pending equipment requests.</p>}
        </ul>
      </section>
    </div>
  );
}
