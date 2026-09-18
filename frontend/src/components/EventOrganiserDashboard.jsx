// EventOrganiserDashboard.jsx

import { useEffect, useState } from "react";
import { getMyEvents, getUpcomingDeadlines } from "../services/eventService";

export default function EventOrganiserDashboard({ user }) {
  const [events, setEvents] = useState([]);
  const [deadlines, setDeadlines] = useState([]);

  useEffect(() => {
    getMyEvents(user.id).then(setEvents);
    getUpcomingDeadlines(user.id).then(setDeadlines);
  }, [user.id]);

  return (
    <div className="dashboard dashboard--organiser">
      <h1>Welcome, {user.name}</h1>

      <section>
        <h2>My events</h2>
        <ul>
          {events.map((event) => (
            <li key={event.id}>
              {event.name} — {event.date} ({event.status})
            </li>
          ))}
          {events.length === 0 && <p>You haven't created any events yet.</p>}
        </ul>
        <button>+ Create new event</button>
      </section>

      <section>
        <h2>Upcoming deadlines</h2>
        <ul>
          {deadlines.map((d) => (
            <li key={d.id}>
              {d.description} — due {d.dueDate}
            </li>
          ))}
          {deadlines.length === 0 && <p>Nothing due soon.</p>}
        </ul>
      </section>
    </div>
  );
}
