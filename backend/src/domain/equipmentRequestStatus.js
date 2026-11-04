/**
 * The statuses of an equipment request.
 *
 * SCRUM-21. 022_equipment_schema.sql asks for this mirror to be added "with the
 * first endpoint that needs it, and a test should assert they match". This is
 * that file, and tests/domain/equipmentRequestStatus.test.js is that test: it
 * reads the enum out of 022 and fails if the two lists ever differ.
 *
 * The values are the database enum's, lowercase with underscores, because they
 * travel through the API exactly as stored. The labels are what a coordinator
 * reads. The lifecycle between them is in SCRUM-290's story, not here.
 */

export const EQUIPMENT_REQUEST_STATUS = Object.freeze({
  PENDING_REVIEW: 'pending_review',
  UNDER_REVIEW: 'under_review',
  ARRANGED: 'arranged',
  CANNOT_BE_FULLY_ARRANGED: 'cannot_be_fully_arranged',
  CANCELLED: 'cancelled',
});

export const EQUIPMENT_REQUEST_STATUS_LABEL = Object.freeze({
  [EQUIPMENT_REQUEST_STATUS.PENDING_REVIEW]: 'Pending review',
  [EQUIPMENT_REQUEST_STATUS.UNDER_REVIEW]: 'Under review',
  [EQUIPMENT_REQUEST_STATUS.ARRANGED]: 'Arranged',
  [EQUIPMENT_REQUEST_STATUS.CANNOT_BE_FULLY_ARRANGED]: 'Cannot be fully arranged',
  [EQUIPMENT_REQUEST_STATUS.CANCELLED]: 'Cancelled',
});

/** The label for a status, or the status itself if it is one this file does not know. */
export function equipmentRequestStatusLabel(status) {
  return EQUIPMENT_REQUEST_STATUS_LABEL[status] ?? status;
}
