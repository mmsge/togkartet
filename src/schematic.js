import { escHtml } from './detail-panel.js';
import { openStationPopup } from './station-popup.js';
import { map } from './map.js';
export { map };

export let network = null;

const networkLayer = L.layerGroup();
const stationLayer = L.layerGroup();
const labelLayer = L.layerGroup();

const linePolylines = []; // [{ tier, polyline }]
const stationDots = [];   // [{ stationId, marker, isTerminal, isInterchange, tiers }]
const stationLabels = []; // [{ stationId, marker, isTerminal, isInterchange, tiers }]

export async function loadNetwork() {
  const netResp = await fetch('data/network.json');
  network = await netResp.json();

  // Build a serviceLineId → schematic line map for live train placement.
  network.serviceLineIndex = {};
  for (const ln of network.lines) {
    for (const sid of (ln.serviceLineIds || [])) {
      network.serviceLineIndex[sid] = ln;
    }
  }

  // animate:false snaps straight to the final zoom so polylines added
  // immediately afterwards project to the right pixels.
  const { minX, minY, maxX, maxY } = network.bounds;
  const bounds = L.latLngBounds([minY, minX], [maxY, maxX]);
  map.fitBounds(bounds, { animate: false, padding: [10, 10] });
  map.setMaxBounds(bounds.pad(0.4));

  drawNetwork();
}

function drawNetwork() {
  networkLayer.clearLayers();
  stationLayer.clearLayers();
  labelLayer.clearLayers();
  linePolylines.length = 0;
  stationDots.length = 0;
  stationLabels.length = 0;

  // Track tiers per station for visibility decisions, and detect terminals.
  const stationTiers = new Map();
  const terminals = new Set();
  for (const ln of network.lines) {
    if (ln.stations.length === 0) continue;
    terminals.add(ln.stations[0]);
    terminals.add(ln.stations[ln.stations.length - 1]);
    for (const id of ln.stations) {
      if (!stationTiers.has(id)) stationTiers.set(id, new Set());
      stationTiers.get(id).add(ln.tier || 'regional');
    }
  }

  for (const ln of network.lines) {
    const poly = (ln.polyline || []).map(p => [p.y, p.x]);
    if (poly.length >= 2) {
      const polyline = L.polyline(poly, {
        color: ln.color,
        weight: 6,
        opacity: 1,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false,
      });
      polyline.addTo(networkLayer);
      linePolylines.push({ tier: ln.tier || 'regional', polyline });
    }
    if (ln.dashed && ln.dashed.length >= 2) {
      const dashed = L.polyline(ln.dashed.map(p => [p.y, p.x]), {
        color: ln.color,
        weight: 6,
        opacity: 1,
        dashArray: '6 6',
        lineCap: 'butt',
        interactive: false,
      });
      dashed.addTo(networkLayer);
      linePolylines.push({ tier: ln.tier || 'regional', polyline: dashed });
    }
  }
  networkLayer.addTo(map);

  // Several Entur IDs alias to the same physical station — collapse those
  // so we draw one dot and one label per visible station.
  const drawn = new Set();
  for (const [id, s] of Object.entries(network.stations)) {
    const key = `${s.x},${s.y}`;
    if (drawn.has(key)) continue;
    drawn.add(key);

    const tiers = stationTiers.get(id) || new Set();
    const dot = L.marker([s.y, s.x], {
      icon: L.divIcon({
        className: 'station-dot',
        html: '',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      interactive: true,
      keyboard: false,
    });
    dot.on('click', (e) => { L.DomEvent.stopPropagation(e); openStationPopup(id, s); });
    dot.addTo(stationLayer);

    const label = L.marker([s.y, s.x], {
      icon: L.divIcon({
        className: 'station-label',
        html: `<span>${escHtml(s.name)}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive: true,
      keyboard: false,
    });
    label.on('click', (e) => { L.DomEvent.stopPropagation(e); openStationPopup(id, s); });
    label.addTo(labelLayer);

    const entry = {
      stationId: id,
      marker: dot,
      labelMarker: label,
      isTerminal: terminals.has(id),
      isInterchange: !!s.interchange,
      tiers,
      nonCommuter: [...tiers].some(t => t !== 'commuter'),
    };
    stationDots.push(entry);
    stationLabels.push(entry);
  }
  stationLayer.addTo(map);
  labelLayer.addTo(map);

  // After fitBounds settles, Leaflet only reprojects polylines added during
  // its zoom animation when something fires `viewreset`. Hook it.
  const repaint = () => { for (const { polyline } of linePolylines) polyline.redraw(); };
  map.whenReady(repaint);
  map.once('moveend zoomend', repaint);
  setTimeout(repaint, 50);
}

// GPS-based placement for vehicles that have lat/lon but no journey data.
// Finds the two geographically nearest unique schematic stations on the line
// and interpolates the schematic position between them.
export function placeOnSchematicByGps(lat, lon, schemLine) {
  if (!network) return null;

  // Collect unique schematic stations (by x,y) that have geographic coords.
  const seen = new Set();
  const pts = [];
  for (const id of schemLine.stations) {
    const s = network.stations[id];
    if (!s || s.lat == null || s.lon == null) continue;
    const key = `${s.x},${s.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push(s);
  }

  if (pts.length === 0) return null;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, bearing: 0 };

  // Squared geographic distance (cosine-corrected longitude delta).
  const cosLat = Math.cos(lat * Math.PI / 180);
  function dist2(s) {
    const dlat = s.lat - lat;
    const dlon = (s.lon - lon) * cosLat;
    return dlat * dlat + dlon * dlon;
  }

  pts.sort((a, b) => dist2(a) - dist2(b));
  const A = pts[0], B = pts[1];

  const dA = Math.sqrt(dist2(A)), dB = Math.sqrt(dist2(B));
  const t = dA / (dA + dB);

  const x = A.x + t * (B.x - A.x);
  const y = A.y + t * (B.y - A.y);
  const bearing = (Math.atan2(B.x - A.x, B.y - A.y) * 180 / Math.PI + 360) % 360;
  return { x, y, bearing };
}

// Strategy: find the schematic line for this journey's Entur line ID, walk
// the journey stops to locate the two curated schematic stops the train is
// currently between, and interpolate by time.
export function placeOnSchematic(journey) {
  if (!network) return null;
  const calls = journey.estimatedCalls || [];
  if (calls.length < 2) return null;

  const serviceLineId = journey.line?.id;
  let schemLine = serviceLineId ? network.serviceLineIndex[serviceLineId] : null;

  // GOA:Line:53 ("Sørtoget lokal") serves both Sørlandsbanen and the
  // Arendalsbanen branch — disambiguate by checking for Arendal in the journey.
  if (schemLine && schemLine.id === 'sorlandsbanen' && calls.some(c => c.quay?.stopPlace?.id === 'NSR:StopPlace:380')) {
    schemLine = network.serviceLineIndex['GOA:Line:53:arendal']
      || network.lines.find(l => l.id === 'arendalsbanen')
      || schemLine;
  }

  if (!schemLine) return null;

  const now = Date.now();
  let nextJourneyIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    const ref = calls[i].expectedArrivalTime || calls[i].aimedArrivalTime
             || calls[i].expectedDepartureTime || calls[i].aimedDepartureTime;
    if (ref && new Date(ref).getTime() > now) { nextJourneyIdx = i; break; }
  }
  if (nextJourneyIdx === -1) nextJourneyIdx = calls.length - 1;

  const schemStops = new Set(schemLine.stations);
  function findSchematicStop(startIdx, dir) {
    for (let i = startIdx; i >= 0 && i < calls.length; i += dir) {
      const id = calls[i].quay?.stopPlace?.id;
      if (id && schemStops.has(id)) return { idx: i, id };
    }
    return null;
  }
  const prev = findSchematicStop(nextJourneyIdx - 1, -1) || findSchematicStop(0, +1);
  const next = findSchematicStop(nextJourneyIdx, +1) || findSchematicStop(calls.length - 1, -1);

  if (!prev && !next) return null;
  const A = prev && network.stations[prev.id];
  const B = next && network.stations[next.id];
  if (!A && !B) return null;
  if (!A || prev.idx === next?.idx) return { y: B.y, x: B.x, bearing: 0 };
  if (!B) return { y: A.y, x: A.x, bearing: 0 };

  const prevDep = new Date(
    calls[prev.idx].expectedDepartureTime || calls[prev.idx].aimedDepartureTime
    || calls[prev.idx].expectedArrivalTime || calls[prev.idx].aimedArrivalTime
  ).getTime();
  const nextArr = new Date(
    calls[next.idx].expectedArrivalTime || calls[next.idx].aimedArrivalTime
    || calls[next.idx].expectedDepartureTime || calls[next.idx].aimedDepartureTime
  ).getTime();
  let t = (now - prevDep) / Math.max(1, nextArr - prevDep);
  if (!isFinite(t)) t = 0.5;
  t = Math.max(0, Math.min(1, t));

  const y = A.y + t * (B.y - A.y);
  const x = A.x + t * (B.x - A.x);
  const dy = B.y - A.y, dx = B.x - A.x;
  const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return { y, x, bearing };
}
