const KEY_LABEL = {
  venue: "Venue",
  equipment: "Equipment",
  no_equipment_confirmation: "No equipment needed",
  date: "Date",
};

export default function ReadinessChecklist({ caption, items }) {
  return (
    <table className="safety-check-submission__checklist">
      <caption>{caption}</caption>
      <thead>
        <tr><th scope="col">Item</th><th scope="col">Status</th><th scope="col">Detail</th></tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${item.key}-${item.bookingId ?? item.equipmentRequestId ?? index}`}>
            <td>{item.key === "venue" && item.venueName ? `Venue: ${item.venueName}` : KEY_LABEL[item.key] ?? "Other"}</td>
            <td>
              <span className={`safety-check-submission__badge safety-check-submission__badge--${item.met ? "met" : "outstanding"}`}>
                {item.met ? "Met" : "Outstanding"}
              </span>
            </td>
            <td>{item.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
