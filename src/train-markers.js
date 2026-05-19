import { CONFIG } from './config.js';
import { map, network, placeOnSchematic, placeOnSchematicByGps } from './schematic.js';
import { journeyCache, JOURNEY_CACHE_TTL, journeyFetchQueue, processJourneyFetchQueue, fetchJourney } from './journey.js';
import { isLineRef } from './gtfs.js';
import { openPanel, showSpinner, renderJourney, escHtml, setDetailContent } from './detail-panel.js';
import { closeStationPopup } from './station-popup.js';

export const trainMarkers = {};
let lastVehicles = [];
export function setLastVehicles(v) { lastVehicles = v; }

// Session-level dedupe so we only log each unmapped line ID once per page load.
const reportedUnmappedLines = new Set();

export function createTrainIcon(operatorCode, bearing) {
  const color = CONFIG.operatorColors[operatorCode] || CONFIG.operatorColors.DEFAULT;
  const b = bearing || 0;
  return L.divIcon({
    className: 'train-icon',
    html: `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="8" fill="${color}" stroke="white" stroke-width="1.5"/>
      <polygon points="10,2 7,10 13,10" fill="white" transform="rotate(${b},10,10)"/>
    </svg>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    tooltipAnchor: [0, -10],
  });
}

function tooltipText(v) {
  const parts = [v.operatorCode !== 'DEFAULT' ? v.operatorCode : ''];
  if (v.tripId) parts.push(v.tripId.split(':').pop());
  if (v.speed > 0) parts.push(`${Math.round(v.speed * 3.6)} km/h`);
  return parts.filter(Boolean).join(' · ');
}

function hideLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.classList.add('hidden');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

export function updateMarkers(vehicles) {
  const seen = new Set();
  let placedCount = 0;
  let awaitingJourney = 0;
  let unmappedLineCount = 0;
  let unplaceable = 0;
  const cycleUnmappedLines = new Set();

  for (const v of vehicles) {
    seen.add(v.id);

    // Only render trains we can place on the schematic. Anything else is
    // queued and skipped so we don't litter the map with off-network dots.
    const cached = v.tripId && journeyCache.get(v.tripId);
    let placed = null;
    if (cached && cached.journey) placed = placeOnSchematic(cached.journey);

    // GPS fallback: vehicles with a known route but no resolved journey
    // (e.g. SJN trains that report position via SIRI-VM without a journey ref).
    if (!placed && v.lat && v.lon && v.routeId && network) {
      const schemLine = network.serviceLineIndex[v.routeId];
      if (schemLine) placed = placeOnSchematicByGps(v.lat, v.lon, schemLine);
    }

    if (placed) {
      placedCount++;
      const pos = [placed.y, placed.x];
      const icon = createTrainIcon(v.operatorCode, placed.bearing);
      if (trainMarkers[v.id]) {
        trainMarkers[v.id].setLatLng(pos);
        trainMarkers[v.id].setIcon(icon);
        trainMarkers[v.id].setTooltipContent(tooltipText(v));
        trainMarkers[v.id]._vehicleData = v;
      } else {
        const marker = L.marker(pos, { icon })
          .addTo(map)
          .bindTooltip(tooltipText(v), { direction: 'top', offset: [0, -10] });
        marker._vehicleData = v;
        marker.on('click', () => onMarkerClick(v.id));
        trainMarkers[v.id] = marker;
      }
    } else {
      if (!cached || !cached.journey) {
        awaitingJourney++;
      } else {
        const lineId = cached.journey.line?.id;
        if (lineId && network && !network.serviceLineIndex[lineId]) {
          unmappedLineCount++;
          cycleUnmappedLines.add(lineId);
        } else {
          unplaceable++;
        }
      }
      if (trainMarkers[v.id]) {
        // Was on the schematic, isn't placeable now — remove until next resolve.
        trainMarkers[v.id].remove();
        delete trainMarkers[v.id];
      }
    }

    // Queue journey fetch if we don't have it yet so the next refresh can
    // place the train on the schematic.
    if (v.tripId && !isLineRef(v.tripId)) {
      const fresh = cached && (Date.now() - cached.fetchedAt < JOURNEY_CACHE_TTL);
      if (!fresh && !journeyFetchQueue.some(q => q.tripId === v.tripId)) {
        journeyFetchQueue.push({ tripId: v.tripId });
      }
    }
  }

  for (const id of Object.keys(trainMarkers)) {
    if (!seen.has(id)) {
      trainMarkers[id].remove();
      delete trainMarkers[id];
    }
  }

  const newlyUnmapped = [...cycleUnmappedLines].filter(id => !reportedUnmappedLines.has(id));
  if (newlyUnmapped.length > 0) {
    for (const id of newlyUnmapped) reportedUnmappedLines.add(id);
    console.info('Trains on lines not in the schematic:', newlyUnmapped);
  }

  if (Object.keys(trainMarkers).length > 0) hideLoadingOverlay();

  // Re-render immediately after each batch of journey fetches so newly-resolved
  // journeys appear without waiting for the next 15-second refresh cycle.
  processJourneyFetchQueue(() => {
    if (lastVehicles.length > 0) updateMarkers(lastVehicles);
  });

  return { total: vehicles.length, placed: placedCount, awaitingJourney, unmappedLine: unmappedLineCount, unplaceable };
}

export async function onMarkerClick(id) {
  closeStationPopup();
  openPanel();
  showSpinner();

  const vehicleData = trainMarkers[id]?._vehicleData;
  if (!vehicleData) {
    setDetailContent('<div class="detail-error">Ingen data tilgjengelig for dette toget.</div>');
    return;
  }

  const tripId = vehicleData.tripId || vehicleData.id;

  // Vehicle has a line ref but no individual journey (e.g. GPS-only SJN trains).
  if (!vehicleData.tripId && vehicleData.routeId && isLineRef(vehicleData.routeId)) {
    const color = CONFIG.operatorColors[vehicleData.operatorCode] || CONFIG.operatorColors.DEFAULT;
    const lineNum = vehicleData.routeId.split(':').pop();
    setDetailContent(`
      <div class="detail-header">
        <span class="detail-line-badge" style="background:${color}">${escHtml(lineNum)}</span>
        <span class="detail-line-name">${escHtml(vehicleData.operatorCode)}</span>
      </div>
      <div class="detail-meta">Kun posisjonsdata tilgjengelig — ingen rutedetaljer for dette toget.</div>`);
    return;
  }

  if (isLineRef(tripId)) {
    const color = CONFIG.operatorColors[vehicleData.operatorCode] || CONFIG.operatorColors.DEFAULT;
    const lineNum = tripId.split(':').pop();
    setDetailContent(`
      <div class="detail-header">
        <span class="detail-line-badge" style="background:${color}">${escHtml(lineNum)}</span>
        <span class="detail-line-name">${escHtml(vehicleData.operatorCode)}</span>
      </div>
      <div class="detail-meta">Kun linjeidentifikator tilgjengelig — ingen sanntidsdata for denne turen.</div>`);
    return;
  }

  try {
    const cached = journeyCache.get(tripId);
    const journey = cached?.journey || await fetchJourney(tripId);
    if (!journey) {
      setDetailContent(`<div class="detail-error">Fant ikke reiseinformasjon for<br><code>${escHtml(tripId)}</code></div>`);
      return;
    }
    if (!cached) journeyCache.set(tripId, { journey, fetchedAt: Date.now() });
    renderJourney(journey, vehicleData);
  } catch (e) {
    console.error('Journey fetch error:', e);
    setDetailContent('<div class="detail-error">Kunne ikke laste reiseinformasjon.</div>');
  }
}
