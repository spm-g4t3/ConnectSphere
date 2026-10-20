import { getData, postData } from "./apiData";

export async function getSafetyReviewQueue() {
  return getData("/safety-reviews");
}

export async function getSafetyReviewHistory() {
  return getData("/safety-reviews/history");
}

export async function getSafetyReview(eventRequestId) {
  return getData(`/safety-reviews/${eventRequestId}`);
}

export async function submitSafetyReviewResponse(eventRequestId, input) {
  return postData(
    `/safety-reviews/${eventRequestId}/responses`,
    input,
  );
}
