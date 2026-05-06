// Tanker Tracker API wrapper.
// Both endpoints are JWT-authed; auth headers + token rotation are
// handled by the shared axios instance in client.js.

import api from './client';

export async function getLatestSnapshot() {
  const { data } = await api.get('/sea/latest');
  return data;
}

export async function getSignalHistory(signalName, days = 90) {
  const { data } = await api.get('/sea/history', {
    params: { signal: signalName, days },
  });
  return data;
}

export async function getSarDetections(days = 7) {
  const { data } = await api.get('/sea/sar-detections', { params: { days } });
  return data;
}
