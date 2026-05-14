import './theme.js';
import { CONFIG } from './config.js';
import { initProto, fetchVehiclePositions } from './gtfs.js';
import { loadNetwork, map, setStationClickHandler } from './schematic.js';
import { openStationPopup, closeStationPopup, prefetchStopBoards } from './station-popup.js';
import { updateMarkers, trainMarkers, setLastVehicles } from './train-markers.js';

const statusBar  = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');

function updateStatusBar(stats, warning) {
  const now = new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const { total = 0, placed = 0 } = stats || {};
  statusText.textContent = `Sist oppdatert: ${now} · ${placed}/${total} tog på skjematisk`;
  statusBar.classList.toggle('warning', !!warning);
}

function hideLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.classList.add('hidden');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

async function refresh() {
  try {
    const vehicles = await fetchVehiclePositions();
    setLastVehicles(vehicles);
    const stats = updateMarkers(vehicles);
    updateStatusBar(stats, false);
  } catch (e) {
    console.error('Refresh error:', e);
    const placed = Object.keys(trainMarkers).length;
    updateStatusBar({ total: placed, placed }, true);
    statusText.textContent = `Feil: ${e.message} — beholder eksisterende markører`;
  }
}

// Wire cross-module interactions that would otherwise create circular imports.
setStationClickHandler(openStationPopup);
map.on('click', closeStationPopup);

(async () => {
  await loadNetwork();
  const protoOk = await initProto();
  if (!protoOk) console.warn('protobuf unavailable, using SIRI-VM');
  await refresh();
  // Fallback: dismiss overlay after 10 s even if no trains loaded (e.g. API failure).
  setTimeout(hideLoadingOverlay, 10_000);
  setInterval(refresh, CONFIG.updateIntervalMs);

  // Warm the stop board cache after the initial render settles, then keep it fresh.
  setTimeout(prefetchStopBoards, 3_000);
  setInterval(prefetchStopBoards, 70_000);
})();
