'use strict';

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  enturClientName: 'noregstoget-poc',
  vehiclePositionsUrl: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
  siriVmUrl: 'https://api.entur.io/realtime/v1/rest/vm',
  journeyPlannerUrl: 'https://api.entur.io/journey-planner/v3/graphql',
  updateIntervalMs: 15000,
  trainCodespaces: ['VYG', 'SJN', 'GOA', 'GJB', 'FLT', 'RUT', 'NSB'],
  operatorColors: {
    VYG: '#e4032e',
    SJN: '#0e7dc2',
    GOA: '#00a651',
    GJB: '#8b4513',
    FLT: '#6a0dad',
    RUT: '#e60000',
    NSB: '#e4032e',
    DEFAULT: '#555555',
  },
};

// ── State ───────────────────────────────────────────────────────────────────

const trainMarkers = {};
let selectedId = null;
let protoRoot = null;

// Schematic network (loaded from data/network.json at boot).
let network = null;
let projectLatLon = (lat, lon) => [lat, lon]; // overwritten once network loads

// Cached journey data per tripId, used to place trains on the schematic.
const journeyCache = new Map(); // tripId → { journey, fetchedAt }
const JOURNEY_CACHE_TTL = 10 * 60 * 1000;

// Cached departure/arrival board data per NSR stop ID.
const stopBoardCache = new Map(); // nsrId → { calls, fetchedAt }
const STOP_BOARD_TTL = 90_000; // 90 s — how long board data is considered fresh
let journeyFetchQueue = [];
let journeyFetchInProgress = false;

// ── Map initialisation (deferred until network.json loads) ──────────────────

const map = L.map('map', {
  crs: L.CRS.Simple,
  center: [0, 0],
  zoom: 1,
  zoomControl: true,
  minZoom: -2,
  maxZoom: 5,
  zoomDelta: 0.5,
  zoomSnap: 0.25,
});

// ── Train icon ──────────────────────────────────────────────────────────────

function createTrainIcon(operatorCode, bearing) {
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

// ── Operator code extraction ────────────────────────────────────────────────

function operatorCodeFrom(id) {
  if (!id) return 'DEFAULT';
  for (const code of CONFIG.trainCodespaces) {
    if (id.startsWith(code + ':') || id.startsWith(code)) return code;
  }
  return 'DEFAULT';
}

function isTrain(id, tripId) {
  const check = (s) => s && CONFIG.trainCodespaces.some(c => s.startsWith(c + ':') || s.startsWith(c));
  return check(id) || check(tripId);
}

// ── Protobuf setup ──────────────────────────────────────────────────────────

const GTFS_RT_PROTO = `
syntax = "proto2";
package transit_realtime;

message FeedMessage {
  required FeedHeader header = 1;
  repeated FeedEntity entity = 2;
}
message FeedHeader {
  required string gtfs_realtime_version = 1;
  optional uint64 timestamp = 3;
}
message FeedEntity {
  required string id = 1;
  optional bool is_deleted = 3;
  optional VehiclePosition vehicle = 4;
}
message VehiclePosition {
  optional TripDescriptor trip = 1;
  optional Position position = 2;
  optional uint64 timestamp = 5;
}
message TripDescriptor {
  optional string trip_id = 1;
  optional string route_id = 5;
}
message Position {
  required float latitude = 1;
  required float longitude = 2;
  optional float bearing = 3;
  optional double odometer = 4;
  optional float speed = 5;
}
`;

async function initProto() {
  try {
    protoRoot = protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
    return true;
  } catch (e) {
    console.warn('protobuf init failed:', e);
    return false;
  }
}

// ── GTFS-RT fetch ───────────────────────────────────────────────────────────

async function fetchGtfsRt() {
  const resp = await fetch(CONFIG.vehiclePositionsUrl, { headers: { 'ET-Client-Name': CONFIG.enturClientName } });
  if (!resp.ok) throw new Error(`GTFS-RT HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const FeedMessage = protoRoot.lookupType('transit_realtime.FeedMessage');
  const feed = FeedMessage.decode(new Uint8Array(buf));

  const vehicles = [];
  for (const entity of feed.entity || []) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;
    const id = entity.id || '';
    const tripId = (vp.trip && vp.trip.trip_id) || '';
    const routeId = (vp.trip && vp.trip.route_id) || '';
    if (!isTrain(id, tripId)) continue;
    vehicles.push({
      id,
      tripId,
      routeId,
      lat: vp.position.latitude,
      lon: vp.position.longitude,
      bearing: vp.position.bearing || 0,
      speed: vp.position.speed || 0,
      operatorCode: operatorCodeFrom(tripId || id),
      timestamp: vp.timestamp ? Number(vp.timestamp) : Date.now() / 1000,
    });
  }
  return vehicles;
}

// ── SIRI-VM fallback ────────────────────────────────────────────────────────

async function fetchSiriVm() {
  const resp = await fetch(CONFIG.siriVmUrl + '?previewInterval=PT0S', {
    headers: {
      'Accept': 'application/json',
      'ET-Client-Name': CONFIG.enturClientName,
    },
  });
  if (!resp.ok) throw new Error(`SIRI-VM HTTP ${resp.status}`);

  const ct = resp.headers.get('content-type') || '';
  const vehicles = [];

  if (ct.includes('json')) {
    const data = await resp.json();
    const activities = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
    for (const act of activities) {
      const mvj = act?.MonitoredVehicleJourney;
      if (!mvj) continue;
      if (mvj.VehicleMode && mvj.VehicleMode !== 'rail') continue;
      const loc = mvj.VehicleLocation;
      if (!loc) continue;
      const lat = parseFloat(loc.Latitude);
      const lon = parseFloat(loc.Longitude);
      if (isNaN(lat) || isNaN(lon)) continue;
      const journeyRef = mvj.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || '';
      const lineRef = mvj.LineRef?.value || mvj.LineRef || '';
      const id = journeyRef || lineRef || String(Math.random());
      if (!isTrain(id, journeyRef)) {
        if (mvj.VehicleMode !== 'rail') continue;
      }
      vehicles.push({
        id,
        tripId: journeyRef,
        routeId: lineRef,
        lat,
        lon,
        bearing: parseFloat(mvj.Bearing || '0') || 0,
        speed: 0,
        operatorCode: operatorCodeFrom(journeyRef || lineRef),
        timestamp: Date.now() / 1000,
      });
    }
  } else {
    const text = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    const activities = doc.querySelectorAll('VehicleActivity');
    for (const act of activities) {
      const mode = act.querySelector('VehicleMode')?.textContent?.trim();
      if (mode && mode !== 'rail') continue;
      const latEl = act.querySelector('VehicleLocation Latitude');
      const lonEl = act.querySelector('VehicleLocation Longitude');
      if (!latEl || !lonEl) continue;
      const lat = parseFloat(latEl.textContent);
      const lon = parseFloat(lonEl.textContent);
      if (isNaN(lat) || isNaN(lon)) continue;
      const journeyRef = act.querySelector('DatedVehicleJourneyRef')?.textContent?.trim() || '';
      const lineRef = act.querySelector('LineRef')?.textContent?.trim() || '';
      const bearing = parseFloat(act.querySelector('Bearing')?.textContent || '0') || 0;
      const id = journeyRef || lineRef || String(Math.random());
      vehicles.push({
        id,
        tripId: journeyRef,
        routeId: lineRef,
        lat,
        lon,
        bearing,
        speed: 0,
        operatorCode: operatorCodeFrom(journeyRef || lineRef),
        timestamp: Date.now() / 1000,
      });
    }
  }
  return vehicles;
}

function isLineRef(id) {
  return id && /^[A-Z]+:Line:/.test(id);
}

async function fetchVehiclePositions() {
  if (protoRoot) {
    try {
      return await fetchGtfsRt();
    } catch (e) {
      console.warn('GTFS-RT failed this cycle, falling back to SIRI-VM:', e.message);
    }
  }
  return fetchSiriVm();
}

// ── Schematic network rendering ─────────────────────────────────────────────

const networkLayer = L.layerGroup();
const stationLayer = L.layerGroup();
const labelLayer = L.layerGroup();

async function loadNetwork() {
  const netResp = await fetch('data/network.json');
  network = await netResp.json();

  // Build a serviceLineId → schematic line map for live train placement.
  network.serviceLineIndex = {};
  for (const ln of network.lines) {
    for (const sid of (ln.serviceLineIds || [])) {
      network.serviceLineIndex[sid] = ln;
    }
  }

  // Fit the map to the network bounds. animate:false snaps us straight to
  // the final zoom so polylines we add immediately afterwards project to
  // the right pixels (with an animated transition Leaflet does not
  // reproject paths added mid-flight).
  const { minX, minY, maxX, maxY } = network.bounds;
  const bounds = L.latLngBounds([minY, minX], [maxY, maxX]);
  map.fitBounds(bounds, { animate: false, padding: [10, 10] });
  map.setMaxBounds(bounds.pad(0.4));

  drawNetwork();
}

// Track which Leaflet objects each station / line owns so we can toggle
// visibility per zoom level without redrawing everything.
const linePolylines = []; // [{ tier, polyline }]
const stationDots = [];   // [{ stationId, marker, isTerminal, isInterchange, tiers }]
const stationLabels = []; // [{ stationId, marker, isTerminal, isInterchange, tiers }]

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

  // Each line carries an explicit polyline (with bend points where lines
  // change direction) plus an optional dashed off-map continuation. We use
  // the polyline geometry verbatim — the layout was hand-authored to match
  // the user's reference SVG so we preserve every diagonal and corner.
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

  // Station dots + labels. Several Entur IDs alias to the same physical
  // station (Bodø, Fauske, Trondheim) — collapse those so we draw one dot
  // and one label per visible station.
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

// ── Light / dark toggle ─────────────────────────────────────────────────────

const themeToggle = document.createElement('button');
themeToggle.id = 'theme-toggle';
themeToggle.textContent = '◐';
themeToggle.title = 'Bytt mellom lyst og mørkt';
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
});
document.body.appendChild(themeToggle);

// ── Train placement on schematic ────────────────────────────────────────────
//
// Strategy: each schematic line lists `serviceLineIds` (Entur line IDs that
// it represents). For a given train:
//   1. find its journey's Entur line ID
//   2. look up the schematic line that hosts that service
//   3. walk the journey's stops to find the two CURATED schematic stops the
//      train is currently between (skipping intermediate stops not in the
//      schematic, e.g. Brumunddal on Dovrebanen)
//   4. interpolate position between them by time
//
// Trains on service lines we don't represent (Trønderbanen, Meråkerbanen,
// Flytoget, Oslo commuter L1/L2 outside the long-distance corridors) return
// null so the caller hides them — keeps the schematic clean.

function placeOnSchematic(journey) {
  if (!network) return null;
  const calls = journey.estimatedCalls || [];
  if (calls.length < 2) return null;

  const serviceLineId = journey.line?.id;
  let schemLine = serviceLineId ? network.serviceLineIndex[serviceLineId] : null;

  // GOA:Line:53 ("Sørtoget lokal") serves both Sørlandsbanen and the
  // Arendalsbanen branch depending on the run. Disambiguate by checking
  // whether Arendal is on the journey.
  if (schemLine && schemLine.id === 'sorlandsbanen' && calls.some(c => c.quay?.stopPlace?.id === 'NSR:StopPlace:380')) {
    schemLine = network.serviceLineIndex['GOA:Line:53:arendal']
      || network.lines.find(l => l.id === 'arendalsbanen')
      || schemLine;
  }

  if (!schemLine) return null;

  // Locate the next journey call that's still in the future (or the last
  // call if the journey is already complete).
  const now = Date.now();
  let nextJourneyIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    const ref = calls[i].expectedArrivalTime || calls[i].aimedArrivalTime
             || calls[i].expectedDepartureTime || calls[i].aimedDepartureTime;
    if (ref && new Date(ref).getTime() > now) { nextJourneyIdx = i; break; }
  }
  if (nextJourneyIdx === -1) nextJourneyIdx = calls.length - 1;

  // Step backward from nextJourneyIdx looking for a journey stop whose
  // stopPlace.id is part of this schematic line; step forward for the next.
  const schemStops = new Set(schemLine.stations);
  function findSchematicStop(startIdx, dir) {
    for (let i = startIdx; i >= 0 && i < calls.length; i += dir) {
      const id = calls[i].quay?.stopPlace?.id;
      if (id && schemStops.has(id)) return { idx: i, id };
    }
    return null;
  }
  const prev = findSchematicStop(nextJourneyIdx - 1, -1)
            || findSchematicStop(0, +1);
  const next = findSchematicStop(nextJourneyIdx, +1)
            || findSchematicStop(calls.length - 1, -1);

  if (!prev && !next) return null;
  const A = prev && network.stations[prev.id];
  const B = next && network.stations[next.id];
  if (!A && !B) return null;
  if (!A || prev.idx === next?.idx) return { y: B.y, x: B.x, bearing: 0 };
  if (!B) return { y: A.y, x: A.x, bearing: 0 };

  // Time interpolation: where is the train along the prev→next segment?
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

// ── Marker management ───────────────────────────────────────────────────────

// Session-level dedupe so we only log each unmapped line ID once per page load.
const reportedUnmappedLines = new Set();

function updateMarkers(vehicles) {
  const seen = new Set();
  let placedCount = 0;
  let awaitingJourney = 0;
  let unmappedLineCount = 0;
  let unplaceable = 0;
  const cycleUnmappedLines = new Set();

  for (const v of vehicles) {
    seen.add(v.id);

    // Only render trains we can place on the schematic. Anything else
    // (services we don't draw, or before we've fetched the journey) is
    // queued and skipped so we don't litter the map with off-network dots.
    const cached = v.tripId && journeyCache.get(v.tripId);
    let placed = null;
    if (cached && cached.journey) placed = placeOnSchematic(cached.journey);

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
        // Was on the schematic, isn't placeable now — remove until we can
        // resolve a journey for it.
        trainMarkers[v.id].remove();
        delete trainMarkers[v.id];
      }
    }

    // Queue journey fetch if we don't have it yet (so the next refresh can
    // place the train on the schematic).
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

  processJourneyFetchQueue();

  return { total: vehicles.length, placed: placedCount, awaitingJourney, unmappedLine: unmappedLineCount, unplaceable };
}

async function processJourneyFetchQueue() {
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
  if (journeyFetchQueue.length > 0) setTimeout(processJourneyFetchQueue, 300);
}

function tooltipText(v) {
  const parts = [v.operatorCode !== 'DEFAULT' ? v.operatorCode : ''];
  if (v.tripId) parts.push(v.tripId.split(':').pop());
  if (v.speed > 0) parts.push(`${Math.round(v.speed * 3.6)} km/h`);
  return parts.filter(Boolean).join(' · ');
}

// ── Status bar ──────────────────────────────────────────────────────────────

const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');

function updateStatusBar(stats, warning) {
  const now = new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const { total = 0, placed = 0 } = stats || {};
  statusText.textContent = `Sist oppdatert: ${now} · ${placed}/${total} tog på skjematisk`;
  statusBar.classList.toggle('warning', !!warning);
}

// ── Detail panel ────────────────────────────────────────────────────────────

const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const detailClose = document.getElementById('detail-close');

detailClose.addEventListener('click', closePanel);

function openPanel() { detailPanel.classList.add('open'); }
function closePanel() { detailPanel.classList.remove('open'); selectedId = null; }
function showSpinner() { detailContent.innerHTML = '<div class="spinner"></div>'; }

function fmt(isoStr) {
  if (!isoStr) return '--:--';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
}

function delayMinutes(aimed, expected) {
  if (!aimed || !expected) return 0;
  return Math.round((new Date(expected) - new Date(aimed)) / 60000);
}

function renderJourney(journey, vehicleData) {
  const line = journey.line || {};
  const operator = line.operator?.name || '—';
  const publicCode = line.publicCode || '';
  const lineName = line.name || '';
  const submode = line.transportSubmode || line.transportMode || '';
  const calls = journey.estimatedCalls || [];

  const color = CONFIG.operatorColors[vehicleData.operatorCode] || CONFIG.operatorColors.DEFAULT;

  const now = Date.now();
  let nextIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    const dept = calls[i].expectedDepartureTime || calls[i].aimedDepartureTime;
    if (dept && new Date(dept).getTime() > now) { nextIdx = i; break; }
  }

  const direction = calls.length > 0 ? (calls[calls.length - 1].quay?.stopPlace?.name || calls[calls.length - 1].quay?.name || '—') : '—';

  const stopItems = calls.map((call, i) => {
    const stopName = call.quay?.stopPlace?.name || call.quay?.name || '—';
    const aimed = call.aimedDepartureTime || call.aimedArrivalTime;
    const expected = call.expectedDepartureTime || call.expectedArrivalTime;
    const actual = call.actualArrivalTime;
    const timeStr = fmt(actual || expected || aimed);
    const delay = delayMinutes(aimed, expected);
    const isNext = i === nextIdx;
    let classes = 'stop-item';
    if (isNext) classes += ' next-stop';
    let delayHtml = '';
    if (delay > 1) delayHtml = `<span class="stop-delay">+${delay} min</span>`;
    let nameHtml = `<span class="stop-name">${escHtml(stopName)}</span>`;
    if (call.cancellation) nameHtml = `<span class="stop-name stop-cancelled">${escHtml(stopName)} (innstilt)</span>`;
    return `<li class="${classes}">
      <span class="stop-time">${timeStr}</span>
      ${nameHtml}
      ${delayHtml}
    </li>`;
  });

  const passedItems = nextIdx > 0 ? stopItems.slice(0, nextIdx) : (nextIdx === -1 ? stopItems : []);
  const upcomingItems = nextIdx >= 0 ? stopItems.slice(nextIdx) : [];

  let html = `
    <div class="detail-header">
      <span class="detail-line-badge" style="background:${color}">${escHtml(publicCode)}</span>
      <span class="detail-line-name">${escHtml(lineName)}</span>
    </div>
    <div class="detail-meta">Operatør: ${escHtml(operator)}</div>
    <div class="detail-meta">Modus: ${escHtml(submode)}</div>
    <div class="detail-meta">Retning: ${escHtml(direction)}</div>
  `;

  if (upcomingItems.length > 0) {
    html += `<div class="detail-section-title">Neste stopp</div><ul class="stop-list">${upcomingItems.join('')}</ul>`;
  }
  if (passedItems.length > 0) {
    html += `<div class="detail-section-title">Passerte stopp</div><ul class="stop-list">${passedItems.join('')}</ul>`;
  }
  if (calls.length === 0) {
    html += '<div class="detail-meta">Ingen stoppinformasjon tilgjengelig.</div>';
  }

  detailContent.innerHTML = html;
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Journey Planner query ───────────────────────────────────────────────────

const JOURNEY_QUERY = `
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

async function fetchJourney(tripId) {
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

// ── Station popup ───────────────────────────────────────────────────────────

const stationPopupEl       = document.getElementById('station-popup');
const stationPopupName     = document.getElementById('station-popup-name');
const stationPopupBoard    = document.getElementById('station-popup-board');
const stationPopupTrackRow = document.getElementById('station-popup-track-row');
const stationPopupTrackInput = document.getElementById('station-popup-track-input');

let spNsrId  = null;
let spView   = 'departure';
let spCalls  = null;

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
    const delaySuffix = delay > 1 ? `<span class="sp-delay">+${delay}'</span>`
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

function openStationPopup(nsrId, station) {
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

function closeStationPopup() {
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

map.on('click', closeStationPopup);

// ── Marker click handler ────────────────────────────────────────────────────

async function onMarkerClick(id) {
  closeStationPopup();
  selectedId = id;
  openPanel();
  showSpinner();

  const vehicleData = trainMarkers[id]?._vehicleData;
  if (!vehicleData) {
    detailContent.innerHTML = '<div class="detail-error">Ingen data tilgjengelig for dette toget.</div>';
    return;
  }

  const tripId = vehicleData.tripId || vehicleData.id;

  if (isLineRef(tripId)) {
    const color = CONFIG.operatorColors[vehicleData.operatorCode] || CONFIG.operatorColors.DEFAULT;
    const lineNum = tripId.split(':').pop();
    detailContent.innerHTML = `
      <div class="detail-header">
        <span class="detail-line-badge" style="background:${color}">${escHtml(lineNum)}</span>
        <span class="detail-line-name">${escHtml(vehicleData.operatorCode)}</span>
      </div>
      <div class="detail-meta">Kun linjeidentifikator tilgjengelig — ingen sanntidsdata for denne turen.</div>`;
    return;
  }

  try {
    const cached = journeyCache.get(tripId);
    const journey = cached?.journey || await fetchJourney(tripId);
    if (!journey) {
      detailContent.innerHTML = `<div class="detail-error">Fant ikke reiseinformasjon for<br><code>${escHtml(tripId)}</code></div>`;
      return;
    }
    if (!cached) journeyCache.set(tripId, { journey, fetchedAt: Date.now() });
    renderJourney(journey, vehicleData);
  } catch (e) {
    console.error('Journey fetch error:', e);
    detailContent.innerHTML = `<div class="detail-error">Kunne ikke laste reiseinformasjon.</div>`;
  }
}

// ── Refresh loop ────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const vehicles = await fetchVehiclePositions();
    const stats = updateMarkers(vehicles);
    updateStatusBar(stats, false);
  } catch (e) {
    console.error('Refresh error:', e);
    const placed = Object.keys(trainMarkers).length;
    updateStatusBar({ total: placed, placed }, true);
    statusText.textContent = `Feil: ${e.message} — beholder eksisterende markører`;
  }
}

// ── Stop board prefetch ─────────────────────────────────────────────────────
// Warm the cache in the background so popups open instantly.
// Major stations fetched first; the rest follow in network order.

const PREFETCH_PRIORITY = [
  'NSR:StopPlace:337',   // Oslo S
  'NSR:StopPlace:548',   // Bergen
  'NSR:StopPlace:596',   // Stavanger
  'NSR:StopPlace:59977', // Trondheim S
];

async function prefetchStopBoards() {
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

  // Priority stations first, then the rest in network order.
  ids.sort((a, b) => {
    const ia = PREFETCH_PRIORITY.indexOf(a);
    const ib = PREFETCH_PRIORITY.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  for (const nsrId of ids) {
    const cached = stopBoardCache.get(nsrId);
    if (cached && Date.now() - cached.fetchedAt < 60_000) continue; // still fresh
    try { await fetchStopCalls(nsrId); } catch { /* ignore background errors */ }
    await new Promise(r => setTimeout(r, 400)); // gentle rate-limit
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  await loadNetwork();
  const protoOk = await initProto();
  if (!protoOk) console.warn('protobuf unavailable, using SIRI-VM');
  await refresh();
  setInterval(refresh, CONFIG.updateIntervalMs);

  // Warm the stop board cache after the initial render settles, then keep it fresh.
  setTimeout(prefetchStopBoards, 3_000);
  setInterval(prefetchStopBoards, 70_000);
})();
