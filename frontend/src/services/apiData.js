// apiData.js
//
// apiClient calls that resolve to the response body, for the services that
// only ever want `.data`. A module of its own, not part of apiClient.js,
// because the service tests replace apiClient.js wholesale with a mock of
// { apiClient }; these call that object, so the mocks need no new exports.

import { apiClient } from "./apiClient";

export async function getData(...args) {
  return (await apiClient.get(...args)).data;
}

export async function postData(...args) {
  return (await apiClient.post(...args)).data;
}

export async function patchData(...args) {
  return (await apiClient.patch(...args)).data;
}

export async function putData(...args) {
  return (await apiClient.put(...args)).data;
}

export async function deleteData(...args) {
  return (await apiClient.delete(...args)).data;
}
