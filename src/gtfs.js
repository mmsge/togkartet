import { CONFIG } from './config.js';

let protoRoot = null;

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

export async function initProto() {
  try {
    protoRoot = protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
    return true;
  } catch (e) {
    console.warn('protobuf init failed:', e);
    return false;
  }
}

export function operatorCodeFrom(id) {
  if (!id) return 'DEFAULT';
  for (const code of CONFIG.trainCodespaces) {
    if (id.startsWith(code + ':') || id.startsWith(code)) return code;
  }
  return 'DEFAULT';
}

export function isTrain(id, tripId) {
  const check = (s) => s && CONFIG.trainCodespaces.some(c => s.startsWith(c + ':') || s.startsWith(c));
  return check(id) || check(tripId);
}

export function isLineRef(id) {
  return id && /^[A-Z]+:Line:/.test(id);
}

export async function fetchGtfsRt() {
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

// Parse a JSON SIRI-VM response body into vehicle objects.
// When `knownTrain` is true the isTrain / VehicleMode filter is skipped —
// used for targeted LineRef requests where we already know these are trains.
function parseSiriVmJson(data, knownTrain = false) {
  const activities = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
  const vehicles = [];
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
    // Prefer VehicleRef for unique identity when no journey ID is available.
    const vehicleRef = mvj.VehicleRef?.value || mvj.VehicleRef || '';
    const id = journeyRef || vehicleRef || lineRef || String(Math.random());
    if (!knownTrain && !isTrain(id, journeyRef)) {
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
  return vehicles;
}

export async function fetchSiriVm() {
  const resp = await fetch(CONFIG.siriVmUrl + '?previewInterval=PT0S', {
    headers: {
      'Accept': 'application/json',
      'ET-Client-Name': CONFIG.enturClientName,
    },
  });
  if (!resp.ok) throw new Error(`SIRI-VM HTTP ${resp.status}`);

  const ct = resp.headers.get('content-type') || '';

  if (ct.includes('json')) {
    const data = await resp.json();
    return parseSiriVmJson(data, false);
  }

  // XML fallback
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const activities = doc.querySelectorAll('VehicleActivity');
  const vehicles = [];
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
    const vehicleRef = act.querySelector('VehicleRef')?.textContent?.trim() || '';
    const bearing = parseFloat(act.querySelector('Bearing')?.textContent || '0') || 0;
    const id = journeyRef || vehicleRef || lineRef || String(Math.random());
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
  return vehicles;
}

// Fetch vehicles for a single line via a targeted SIRI-VM LineRef query.
// These trains are known to be rail, so the isTrain filter is bypassed.
async function fetchSiriVmByLine(lineRef) {
  try {
    const resp = await fetch(
      `${CONFIG.siriVmUrl}?previewInterval=PT0S&LineRef=${encodeURIComponent(lineRef)}`,
      { headers: { 'Accept': 'application/json', 'ET-Client-Name': CONFIG.enturClientName } },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return parseSiriVmJson(data, true);
  } catch {
    return [];
  }
}

export async function fetchVehiclePositions() {
  // Primary feed: GTFS-RT protobuf (covers VYG, GOA, FLT, …)
  let mainVehicles;
  if (protoRoot) {
    try {
      mainVehicles = await fetchGtfsRt();
    } catch (e) {
      console.warn('GTFS-RT failed this cycle, falling back to SIRI-VM:', e.message);
      mainVehicles = await fetchSiriVm();
    }
  } else {
    mainVehicles = await fetchSiriVm();
  }

  // Supplementary: targeted per-line SIRI-VM requests for operators (e.g. SJN)
  // whose vehicles fall outside the top-1000 unfiltered SIRI-VM result set.
  const suppResults = await Promise.allSettled(
    CONFIG.supplementaryLineRefs.map(lr => fetchSiriVmByLine(lr)),
  );
  const mainIds = new Set(mainVehicles.map(v => v.id));
  for (const result of suppResults) {
    if (result.status !== 'fulfilled') continue;
    for (const v of result.value) {
      if (!mainIds.has(v.id)) {
        mainIds.add(v.id);
        mainVehicles.push(v);
      }
    }
  }

  return mainVehicles;
}
