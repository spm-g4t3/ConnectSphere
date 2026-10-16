import { apiClient } from "./apiClient";

export async function getSafetyReviewQueue() {
  const response = await apiClient.get("/safety-reviews");
  return response.data;
}

export async function getSafetyReviewHistory() {
  const response = await apiClient.get("/safety-reviews/history");
  return response.data;
}

export async function getSafetyReview(eventRequestId) {
  const response = await apiClient.get(`/safety-reviews/${eventRequestId}`);
  return response.data;
}

export async function submitSafetyReviewResponse(eventRequestId, input) {
  const response = await apiClient.post(
    `/safety-reviews/${eventRequestId}/responses`,
    input,
  );
  return response.data;
}
