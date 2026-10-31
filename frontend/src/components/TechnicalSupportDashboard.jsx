// TechnicalSupportDashboard.jsx

import EquipmentRequestQueue from "./EquipmentRequestQueue";
import EquipmentReviewedByMe from "./EquipmentReviewedByMe";
import NotificationInbox from "./NotificationInbox";

export default function TechnicalSupportDashboard({ user }) {
  return (
    <div className="dashboard dashboard--tech-support">
      <h1>Welcome, {user.name ?? user.email}</h1>

      {/* Renders its own <section>s, so each is a direct child of .dashboard and gets the card styling. */}
      <EquipmentRequestQueue />
      <EquipmentReviewedByMe />

      <NotificationInbox />
    </div>
  );
}
