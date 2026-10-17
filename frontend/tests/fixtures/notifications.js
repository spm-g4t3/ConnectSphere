// notifications.js
//
// Notification payloads shared by the inbox and wording tests. The times carry
// +08:00 offsets, so expected strings built from them pass in any time zone.

// booking_flagged: the payload 014 writes when a venue block flags a booking.
export const PAYLOAD = {
  venueName: "Hall A",
  eventName: "Tech Talk",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
  reason: "maintenance",
  blockStartsAt: "2026-10-01T09:00:00+08:00",
  blockEndsAt: "2026-10-01T17:00:00+08:00",
};

// SCRUM-484 (AC8). The payload 034 writes when a setup or turnaround change
// flags a booking (B-AC8-21's shape).
export const SETUP_PAYLOAD = {
  venueName: "Harbour Room",
  eventName: "Orientation",
  startsAt: "2026-11-02T10:00:00+08:00",
  endsAt: "2026-11-02T12:00:00+08:00",
  occupiedStartsAt: "2026-11-02T09:30:00+08:00",
  occupiedEndsAt: "2026-11-02T12:15:00+08:00",
  setupMinutes: 30,
  turnaroundMinutes: 15,
  reason: "The venue's setup or turnaround time changed.",
};
