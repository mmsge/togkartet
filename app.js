'use strict';

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  enturClientName: 'noregstoget-poc',
  vehiclePositionsUrl: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
  siriVmUrl: 'https://api.entur.io/realtime/v1/rest/vm',
  journeyPlannerUrl: 'https://api.entur.io/journey-planner/v3/graphql',
  updateIntervalMs: 15000,
  map: {
    center: [65.0, 15.0],
    zoom: 5,
  },
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
let useProtobuf = true;

// ── Map initialisation ──────────────────────────────────────────────────────

const map = L.map('map', {
  center: CONFIG.map.center,
  zoom: CONFIG.map.zoom,
  zoomControl: true,
});

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const ormLayer = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
  maxZoom: 19,
  opacity: 0.7,
});

L.control.layers(
  { 'OpenStreetMap': osmLayer },
  { 'Railway overlay': ormLayer },
  { collapsed: false }
).addTo(map);

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

// Minimal inline GTFS-RT proto schema as a string, loaded synchronously
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
  optional float speed = 4;
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
        // for SIRI, if mode is rail we include it regardless
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
    // XML path
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

// ── Fetch vehicle positions (with fallback) ─────────────────────────────────

async function fetchVehiclePositions() {
  if (useProtobuf && protoRoot) {
    try {
      const vehicles = await fetchGtfsRt();
      if (vehicles.length > 0) return vehicles;
      // Zero results might mean filtering is too strict — still return
      return vehicles;
    } catch (e) {
      console.warn('GTFS-RT failed, falling back to SIRI-VM:', e);
      useProtobuf = false;
    }
  }
  return fetchSiriVm();
}

// ── Marker management ───────────────────────────────────────────────────────

function updateMarkers(vehicles) {
  const seen = new Set();

  for (const v of vehicles) {
    seen.add(v.id);
    const icon = createTrainIcon(v.operatorCode, v.bearing);

    if (trainMarkers[v.id]) {
      trainMarkers[v.id].setLatLng([v.lat, v.lon]);
      trainMarkers[v.id].setIcon(icon);
      trainMarkers[v.id]._vehicleData = v;
    } else {
      const marker = L.marker([v.lat, v.lon], { icon })
        .addTo(map)
        .bindTooltip(v.tripId || v.id, { direction: 'top', offset: [0, -10] });
      marker._vehicleData = v;
      marker.on('click', () => onMarkerClick(v.id));
      trainMarkers[v.id] = marker;
    }
  }

  // Remove stale markers
  for (const id of Object.keys(trainMarkers)) {
    if (!seen.has(id)) {
      trainMarkers[id].remove();
      delete trainMarkers[id];
    }
  }
}

// ── Status bar ──────────────────────────────────────────────────────────────

const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');

function updateStatusBar(count, warning) {
  const now = new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  statusText.textContent = `Sist oppdatert: ${now} · ${count} tog`;
  statusBar.classList.toggle('warning', !!warning);
}

// ── Detail panel ────────────────────────────────────────────────────────────

const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const detailClose = document.getElementById('detail-close');

detailClose.addEventListener('click', closePanel);

function openPanel() {
  detailPanel.classList.add('open');
}

function closePanel() {
  detailPanel.classList.remove('open');
  selectedId = null;
}

function showSpinner() {
  detailContent.innerHTML = '<div class="spinner"></div>';
}

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

  // Determine next stop
  const now = Date.now();
  let nextIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    const dept = calls[i].expectedDepartureTime || calls[i].aimedDepartureTime;
    if (dept && new Date(dept).getTime() > now) {
      nextIdx = i;
      break;
    }
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
    const isPassed = nextIdx >= 0 ? i < nextIdx : (actual != null);

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

  // Split into upcoming and passed
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
      publicCode
      name
      operator { name }
      transportMode
      transportSubmode
    }
    estimatedCalls {
      quay {
        name
        stopPlace { name }
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
  // Try the raw tripId, and also strip any date suffix if present
  const ids = [tripId];
  // If tripId has a date suffix like _2025-05-13 or -2025-05-13, try without
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

// ── Marker click handler ────────────────────────────────────────────────────

async function onMarkerClick(id) {
  selectedId = id;
  openPanel();
  showSpinner();

  const vehicleData = trainMarkers[id]?._vehicleData;
  if (!vehicleData) {
    detailContent.innerHTML = '<div class="detail-error">Ingen data tilgjengelig for dette toget.</div>';
    return;
  }

  const tripId = vehicleData.tripId || vehicleData.id;
  console.log('Fetching journey for tripId:', tripId);

  try {
    const journey = await fetchJourney(tripId);
    if (!journey) {
      detailContent.innerHTML = `<div class="detail-error">Fant ikke reiseinformasjon for<br><code>${escHtml(tripId)}</code></div>`;
      return;
    }
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
    updateMarkers(vehicles);
    updateStatusBar(vehicles.length, false);
  } catch (e) {
    console.error('Refresh error:', e);
    updateStatusBar(Object.keys(trainMarkers).length, true);
    statusText.textContent = `Feil ved oppdatering: ${e.message} — beholder eksisterende markører`;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  const protoOk = await initProto();
  if (!protoOk) {
    useProtobuf = false;
    console.warn('protobuf unavailable, using SIRI-VM');
  }
  await refresh();
  setInterval(refresh, CONFIG.updateIntervalMs);
})();
