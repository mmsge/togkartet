import { CONFIG } from './config.js';

export const journeyCache = new Map();
export const JOURNEY_CACHE_TTL = 10 * 60 * 1000;
export const journeyFetchQueue = [];
let journeyFetchInProgress = false;

export const JOURNEY_QUERY = `
query ServiceJourney($id: String!) {
  serviceJourney(id: $id) {
    id
    line {
      id
      publicCode
      name
      operator { name }
      transportMode
      transportSubmode
    }
    estimatedCalls {
      quay {
        name
        latitude
        longitude
        stopPlace { id name }
      }
      aimedArrivalTime
      expectedArrivalTime
      aimedDepartureTime
      expectedDepartureTime
      actualArrivalTime
      cancellation
      realtime
    }
  }
}
`;

export async function fetchJourney(tripId) {
  const ids = [tripId];
  const stripped = tripId.replace(/[_-]\d{4}-\d{2}-\d{2}$/, '');
  if (stripped !== tripId) ids.push(stripped);

  for (const id of ids) {
    const resp = await fetch(CONFIG.journeyPlannerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ET-Client-Name': CONFIG.enturClientName,
      },
      body: JSON.stringify({ query: JOURNEY_QUERY, variables: { id } }),
    });
    if (!resp.ok) throw new Error(`Journey planner HTTP ${resp.status}`);
    const data = await resp.json();
    if (data?.data?.serviceJourney) return data.data.serviceJourney;
  }
  return null;
}

// onBatchComplete is called after each batch of journeys resolves so the
// caller (train-markers) can re-render without waiting for the full queue.
export async function processJourneyFetchQueue(onBatchComplete) {
  if (journeyFetchInProgress || journeyFetchQueue.length === 0) return;
  journeyFetchInProgress = true;
  const batch = journeyFetchQueue.splice(0, 5);
  await Promise.allSettled(batch.map(async ({ tripId }) => {
    try {
      const journey = await fetchJourney(tripId);
      if (journey) journeyCache.set(tripId, { journey, fetchedAt: Date.now() });
    } catch (e) {
      console.warn(`Journey fetch failed for ${tripId}:`, e.message);
    }
  }));
  journeyFetchInProgress = false;
  onBatchComplete?.();
  if (journeyFetchQueue.length > 0) setTimeout(() => processJourneyFetchQueue(onBatchComplete), 300);
}
