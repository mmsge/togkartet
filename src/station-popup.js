import { CONFIG } from './config.js';
import { map } from './map.js';
import { escHtml } from './detail-panel.js';

const stationPopupEl        = document.getElementById('station-popup');
const stationPopupName      = document.getElementById('station-popup-name');
const stationPopupBoard     = document.getElementById('station-popup-board');
const stationPopupTrackRow  = document.getElementById('station-popup-track-row');
const stationPopupTrackInput = document.getElementById('station-popup-track-input');

const stopBoardCache = new Map();
const STOP_BOARD_TTL = 90_000;

const PREFETCH_PRIORITY = [
  'NSR:StopPlace:337',   // Oslo S
  'NSR:StopPlace:548',   // Bergen
  'NSR:StopPlace:596',   // Stavanger
  'NSR:StopPlace:59977', // Trondheim S
];

let spNsrId = null;
let spView  = 'departure';
let spCalls = null;

const SP_BOARD_QUERY = `
query StopBoard($id: String!) {
  stopPlace(id: $id) {
    estimatedCalls(numberOfDepartures: 20, timeRange: 43200) {
      realtime
      cancellation
      expectedDepartureTime
      aimedDepartureTime
      expectedArrivalTime
      aimedArrivalTime
      quay { publicCode }
      destinationDisplay { frontText }
      serviceJourney { line { publicCode } }
    }
  }
}`;

async function fetchStopCalls(nsrId) {
  const cached = stopBoardCache.get(nsrId);
  if (cached && Date.now() - cached.fetchedAt < STOP_BOARD_TTL) return cached.calls;

  const resp = await fetch(CONFIG.journeyPlannerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ET-Client-Name': CONFIG.enturClientName },
    body: JSON.stringify({ query: SP_BOARD_QUERY, variables: { id: nsrId } }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const calls = data?.data?.stopPlace?.estimatedCalls ?? [];
  stopBoardCache.set(nsrId, { calls, fetchedAt: Date.now() });
  return calls;
}

function spFormatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
}

function spFilteredCalls() {
  if (!spCalls) return [];
  const isArrival = spView === 'arrival';
  const trackFilter = stationPopupTrackInput.value.trim();
  let calls = spCalls.filter(c => isArrival ? c.expectedArrivalTime : c.expectedDepartureTime);
  if (spView === 'track' && trackFilter) {
    calls = calls.filter(c => c.quay?.publicCode === trackFilter);
  }
  calls.sort((a, b) => {
    const ta = isArrival ? a.expectedArrivalTime : a.expectedDepartureTime;
    const tb = isArrival ? b.expectedArrivalTime : b.expectedDepartureTime;
    return new Date(ta) - new Date(tb);
  });
  return calls.slice(0, 15);
}

function spRenderBoard() {
  const calls = spFilteredCalls();
  const isArrival = spView === 'arrival';

  if (calls.length === 0) {
    stationPopupBoard.innerHTML = '<div class="sp-empty">Ingen avganger funnet.</div>';
    return;
  }

  const rows = calls.map(c => {
    const time  = isArrival ? c.expectedArrivalTime  : c.expectedDepartureTime;
    const aimed = isArrival ? c.aimedArrivalTime      : c.aimedDepartureTime;
    const delay = aimed ? Math.round((new Date(time) - new Date(aimed)) / 60000) : 0;
    const delaySuffix = delay > 1  ? `<span class="sp-delay">+${delay}'</span>`
                      : delay < -1 ? `<span class="sp-early">${delay}'</span>` : '';
    const line  = escHtml(c.serviceJourney?.line?.publicCode || '');
    const dest  = escHtml(c.destinationDisplay?.frontText || '');
    const track = escHtml(c.quay?.publicCode || '');
    const cls   = c.cancellation ? ' class="sp-row-cancelled"' : '';
    return `<tr${cls}>
      <td class="sp-time">${spFormatTime(time)}${delaySuffix}</td>
      <td class="sp-rt">${c.realtime ? '●' : '○'}</td>
      <td class="sp-line">${line}</td>
      <td class="sp-dest">${dest}</td>
      <td class="sp-track">${track}</td>
    </tr>`;
  }).join('');

  stationPopupBoard.innerHTML = `<table class="sp-table">
    <thead><tr>
      <th>Tid</th><th></th><th>Tog</th>
      <th>${isArrival ? 'Fra' : 'Til'}</th><th>Spor</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function spLoad() {
  const isCached = stopBoardCache.has(spNsrId) &&
    Date.now() - stopBoardCache.get(spNsrId).fetchedAt < STOP_BOARD_TTL;
  if (!isCached) stationPopupBoard.innerHTML = '<div class="spinner"></div>';
  try {
    spCalls = await fetchStopCalls(spNsrId);
    spRenderBoard();
  } catch (e) {
    stationPopupBoard.innerHTML = `<div class="sp-error">Kunne ikke laste avganger.</div>`;
  }
}

export function openStationPopup(nsrId, station) {
  spNsrId = nsrId;
  spView  = 'departure';
  spCalls = null;
  stationPopupName.textContent = station.name;

  document.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.sp-tab[data-view="departure"]').classList.add('active');
  stationPopupTrackRow.hidden = true;
  stationPopupTrackInput.value = '';

  const POPUP_W = 460, POPUP_H = 400;
  const pt = map.latLngToContainerPoint([station.y, station.x]);
  const mw = map.getContainer().offsetWidth;
  const mh = map.getContainer().offsetHeight;
  let left = pt.x + 18;
  let top  = pt.y - 80;
  if (left + POPUP_W > mw - 8) left = pt.x - POPUP_W - 18;
  if (left < 8) left = 8;
  if (top + POPUP_H > mh - 8) top = mh - POPUP_H - 8;
  if (top < 8) top = 8;

  stationPopupEl.style.left = `${left}px`;
  stationPopupEl.style.top  = `${top}px`;
  stationPopupEl.hidden = false;
  spLoad();
}

export function closeStationPopup() {
  stationPopupEl.hidden = true;
  spNsrId = null;
  spCalls = null;
}

document.getElementById('station-popup-close').addEventListener('click', closeStationPopup);

document.querySelectorAll('.sp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    spView = tab.dataset.view;
    document.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    stationPopupTrackRow.hidden = spView !== 'track';
    if (spCalls) spRenderBoard(); else spLoad();
  });
});

stationPopupTrackInput.addEventListener('input', () => { if (spCalls) spRenderBoard(); });

// Warm the stop board cache in the background so popups open instantly.
// Major stations are fetched first; the rest follow in network order.
export async function prefetchStopBoards(network) {
  if (!network) return;

  // Collect one NSR ID per unique physical station (same dedup as the map).
  const drawn = new Set();
  const ids = [];
  for (const [id, s] of Object.entries(network.stations)) {
    const key = `${s.x},${s.y}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    ids.push(id);
  }

  ids.sort((a, b) => {
    const ia = PREFETCH_PRIORITY.indexOf(a);
    const ib = PREFETCH_PRIORITY.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  for (const nsrId of ids) {
    const cached = stopBoardCache.get(nsrId);
    if (cached && Date.now() - cached.fetchedAt < 60_000) continue;
    try { await fetchStopCalls(nsrId); } catch { /* ignore background errors */ }
    await new Promise(r => setTimeout(r, 400)); // gentle rate-limit
  }
}
