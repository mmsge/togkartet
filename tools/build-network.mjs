#!/usr/bin/env node
// Generate data/network.json from a hand-authored schematic. Coordinates
// match the user's metromapmaker.com map (TN7q-Qcf) one-for-one — the SVG
// viewBox is 0..120 and station positions in this file are the exact
// integer coordinates from that SVG, with y negated so that on a Leaflet
// L.CRS.Simple map (where larger lat = up) north appears at the top.
//
// Lines record an explicit polyline path that may include bend points
// between stations, so the rendered geometry matches the source map's
// diagonals and right-angle turns.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'network.json');

// ── Stations ────────────────────────────────────────────────────────────────
// `ids` lists every Entur stopPlace ID that should resolve to this station.

// bnCode is the Bane NOR telegraphic station abbreviation used by rtd.banenor.no.
// null = no departure board available for this station.
const STATIONS = {
  Bergen:        { x:  7, y: -60, lat: 60.39,     lon: 5.3337,    ids: ['NSR:StopPlace:548'],                                             bnCode: 'BRG'  },
  Voss:          { x: 11, y: -60, lat: 60.6291,   lon: 6.4098,    ids: ['NSR:StopPlace:440'],                                             bnCode: 'VOS'  },
  Flåm:          { x: 16, y: -55, lat: 60.8632,   lon: 7.1138,    ids: ['NSR:StopPlace:231'],                                             bnCode: 'FLAM' },
  Myrdal:        { x: 16, y: -60, lat: 60.7351,   lon: 7.1230,    ids: ['NSR:StopPlace:222'],                                             bnCode: 'MRL'  },
  Åndalsnes:     { x: 24, y: -43, lat: 62.5660,   lon: 7.6859,    ids: ['NSR:StopPlace:520'],                                             bnCode: 'AND'  },
  Geilo:         { x: 27, y: -60, lat: 60.5347,   lon: 8.2067,    ids: ['NSR:StopPlace:318'],                                             bnCode: 'GEI'  },
  Hønefoss:      { x: 30, y: -63, lat: 60.1692,   lon: 10.2489,   ids: ['NSR:StopPlace:158'],                                             bnCode: 'HNF'  },
  'Trondheim S': { x: 34, y: -34, lat: 63.436279, lon: 10.399123, ids: ['NSR:StopPlace:59977', 'NSR:StopPlace:659'],                      bnCode: 'T'    },
  Støren:        { x: 34, y: -38, lat: 63.0421,   lon: 10.2858,   ids: ['NSR:StopPlace:603'],                                             bnCode: 'SR'   },
  Dombås:        { x: 34, y: -47, lat: 62.0759,   lon: 9.1218,    ids: ['NSR:StopPlace:645'],                                             bnCode: 'DB'   },
  Vinstra:       { x: 34, y: -53, lat: 61.5944,   lon: 9.7351,    ids: ['NSR:StopPlace:425'],                                             bnCode: 'VIS'  },
  Drammen:       { x: 34, y: -67, lat: 59.7400,   lon: 10.2050,   ids: ['NSR:StopPlace:11'],                                              bnCode: 'DM'   },
  Lillehammer:   { x: 37, y: -56, lat: 61.1167,   lon: 10.4612,   ids: ['NSR:StopPlace:420'],                                             bnCode: 'LHM'  },
  Steinkjer:     { x: 38, y: -26, lat: 64.0157,   lon: 11.4998,   ids: ['NSR:StopPlace:714'],                                             bnCode: 'SK'   },
  Stjørdal:      { x: 38, y: -30, lat: 63.4719,   lon: 10.9249,   ids: ['NSR:StopPlace:712'],                                             bnCode: 'STD'  },
  Bodø:          { x: 39, y: -17, lat: 67.2851,   lon: 14.3879,   ids: ['NSR:StopPlace:507', 'NSR:StopPlace:510', 'NSR:StopPlace:58952'], bnCode: 'BO'   },
  Narvik:        { x: 40, y: -12, lat: 68.44151,  lon: 17.441289, ids: ['NSR:StopPlace:62318', 'NSR:StopPlace:58234'],                    bnCode: 'NAR'  },
  Kopperå:       { x: 40, y: -34, lat: 63.392005, lon: 11.847768, ids: ['NSR:StopPlace:62376', 'NSR:StopPlace:592'],                     bnCode: null   },
  Hamar:         { x: 40, y: -59, lat: 60.7960,   lon: 11.0700,   ids: ['NSR:StopPlace:219'],                                             bnCode: 'HAM'  },
  'Oslo S':      { x: 40, y: -65, lat: 59.9111,   lon: 10.7557,   ids: ['NSR:StopPlace:337'],                                             bnCode: 'OS'   },
  Fauske:        { x: 41, y: -19, lat: 67.2599,   lon: 15.3927,   ids: ['NSR:StopPlace:176', 'NSR:StopPlace:182', 'NSR:StopPlace:58954'], bnCode: 'FK'   },
  'Mo i Rana':   { x: 41, y: -23, lat: 66.3145,   lon: 14.1421,   ids: ['NSR:StopPlace:195'],                                             bnCode: 'MO'   },
  Stavanger:     { x:  8, y: -71, lat: 58.9696,   lon: 5.7332,    ids: ['NSR:StopPlace:596'],                                             bnCode: 'STV'  },
  Sandnes:       { x:  8, y: -73, lat: 58.852305, lon: 5.736575,  ids: ['NSR:StopPlace:702'],                                             bnCode: 'SAS'  },
  Egersund:      { x: 12, y: -77, lat: 58.4517,   lon: 6.0008,    ids: ['NSR:StopPlace:82'],                                              bnCode: 'EG'   },
  Kristiansand:  { x: 24, y: -77, lat: 58.14559,  lon: 7.988067,  ids: ['NSR:StopPlace:61608'],                                           bnCode: 'KRS'  },
  Nelaug:        { x: 28, y: -73, lat: 58.6650,   lon: 8.6260,    ids: ['NSR:StopPlace:250'],                                             bnCode: 'NEL'  },
  Arendal:       { x: 28, y: -75, lat: 58.4636,   lon: 8.7720,    ids: ['NSR:StopPlace:380'],                                             bnCode: 'ARD'  },
  Røros:         { x: 43, y: -47, lat: 62.5743,   lon: 11.3823,   ids: ['NSR:StopPlace:53'],                                              bnCode: 'RO'   },
  Ski:           { x: 43, y: -72, lat: 59.7197,   lon: 10.8358,   ids: ['NSR:StopPlace:127'],                                             bnCode: 'SKI'  },
  Bjørnfjell:    { x: 45, y: -12, lat: 68.432799, lon: 18.070133, ids: ['NSR:StopPlace:62317', 'NSR:StopPlace:58576'],                    bnCode: null   },
  Elverum:       { x: 45, y: -54, lat: 60.8807,   lon: 11.5631,   ids: ['NSR:StopPlace:117'],                                             bnCode: 'ELV'  },
  Halden:        { x: 45, y: -77, lat: 59.1242,   lon: 11.3863,   ids: ['NSR:StopPlace:192'],                                             bnCode: 'HAL'  },
  Kongsvinger:   { x: 51, y: -61, lat: 60.1900,   lon: 11.9970,   ids: ['NSR:StopPlace:635'],                                             bnCode: 'KV'   },
};

// ── Polyline helper ─────────────────────────────────────────────────────────
// Each line is a polyline that passes through station names (resolved to
// their (x,y)) and optional explicit {x,y} bend points. A `dashed` array
// appends an off-map continuation drawn as a dashed line.
//
// Refer to https://metromapmaker.com/map/TN7q-Qcf and the corresponding SVG
// for the exact geometry — the bend points below are taken verbatim from
// that SVG.

function S(name) {
  const st = STATIONS[name];
  if (!st) throw new Error(`Unknown station: ${name}`);
  return { x: st.x, y: st.y, station: name };
}
function P(x, y) { return { x, y: -y }; } // pure bend, SVG y → schematic y

const LINES = [
  {
    id: 'bergensbanen',
    name: 'Bergensbanen',
    color: '#00b251',
    tier: 'trunk',
    serviceLineIds: ['VYG:Line:F4', 'VYG:Line:R40', 'VYG:Line:L4'],
    stops: ['Bergen', 'Voss', 'Myrdal', 'Geilo', 'Hønefoss', 'Drammen', 'Oslo S'],
    polyline: [
      S('Bergen'), S('Voss'), S('Myrdal'), S('Geilo'),
      S('Hønefoss'), P(33, 66),
      S('Drammen'), P(35, 66), P(36, 65),
      S('Oslo S'),
    ],
  },
  {
    id: 'flamsbana',
    name: 'Flåmsbana',
    color: '#a2a2a2',
    tier: 'branch',
    serviceLineIds: ['VYG:Line:R45'],
    stops: ['Flåm', 'Myrdal'],
    polyline: [S('Flåm'), S('Myrdal')],
  },
  {
    id: 'sorlandsbanen',
    name: 'Sørlandsbanen',
    color: '#0896d7',
    tier: 'trunk',
    serviceLineIds: ['GOA:Line:50', 'GOA:Line:59'],
    stops: ['Stavanger', 'Sandnes', 'Egersund', 'Kristiansand', 'Nelaug', 'Drammen'],
    polyline: [
      S('Stavanger'), S('Sandnes'), S('Egersund'),
      S('Kristiansand'), P(27, 74),
      S('Nelaug'), P(29, 72),
      S('Drammen'),
    ],
  },
  {
    id: 'raumabanen',
    name: 'Raumabanen',
    color: '#f0ce15',
    tier: 'branch',
    serviceLineIds: ['SJN:Line:22'],
    stops: ['Åndalsnes', 'Dombås'],
    polyline: [S('Åndalsnes'), P(30, 43), S('Dombås')],
  },
  {
    id: 'arendalsbanen',
    name: 'Arendalsbanen',
    color: '#f0ce15',
    tier: 'branch',
    serviceLineIds: ['GOA:Line:53'],
    stops: ['Nelaug', 'Arendal'],
    polyline: [S('Nelaug'), S('Arendal')],
  },
  {
    id: 'dovrebanen',
    name: 'Dovrebanen',
    color: '#9768ee',
    tier: 'trunk',
    serviceLineIds: ['SJN:Line:21', 'VYG:Line:RE10'],
    stops: ['Trondheim S', 'Støren', 'Dombås', 'Vinstra', 'Lillehammer', 'Hamar', 'Oslo S'],
    polyline: [
      S('Trondheim S'), S('Støren'), S('Dombås'),
      S('Vinstra'), S('Lillehammer'), S('Hamar'), S('Oslo S'),
    ],
  },
  {
    id: 'rorosbanen',
    name: 'Rørosbanen',
    color: '#df8600',
    tier: 'regional',
    serviceLineIds: ['SJN:Line:25'],
    stops: ['Støren', 'Røros', 'Elverum', 'Hamar'],
    polyline: [
      S('Støren'), S('Røros'), P(45, 49),
      S('Elverum'), P(41, 58),
      S('Hamar'),
    ],
  },
  {
    id: 'nordlandsbanen',
    name: 'Nordlandsbanen',
    color: '#2954ff',
    tier: 'trunk',
    serviceLineIds: ['SJN:Line:71', 'SJN:Line:79', 'SJN:Line:26'],
    stops: ['Bodø', 'Fauske', 'Mo i Rana', 'Steinkjer', 'Stjørdal', 'Trondheim S'],
    polyline: [
      S('Bodø'), S('Fauske'), S('Mo i Rana'),
      S('Steinkjer'), S('Stjørdal'), S('Trondheim S'),
    ],
  },
  {
    id: 'ofotbanen',
    name: 'Ofotbanen',
    color: '#ff00d0',
    tier: 'trunk',
    serviceLineIds: ['SJV:Line:0ff9f2b9-fbe5-4761-8a29-8813be35efaa'],
    stops: ['Narvik', 'Bjørnfjell'],
    polyline: [S('Narvik'), S('Bjørnfjell')],
    dashed: [P(46, 12), P(52, 12)],
  },
  {
    id: 'merakerbanen',
    name: 'Meråkerbanen',
    color: '#ff00d0',
    tier: 'regional',
    serviceLineIds: ['SJN:Line:72'],
    stops: ['Trondheim S', 'Kopperå'],
    polyline: [S('Trondheim S'), P(35, 34), S('Kopperå')],
    dashed: [P(41, 34), P(45, 34)],
  },
  {
    id: 'kongsvingerbanen',
    name: 'Kongsvingerbanen',
    color: '#ff00d0',
    tier: 'regional',
    serviceLineIds: ['VYG:Line:R14'],
    stops: ['Oslo S', 'Kongsvinger'],
    polyline: [S('Oslo S'), P(46, 65), P(50, 61), S('Kongsvinger')],
    dashed: [P(52, 61), P(57, 61)],
  },
  {
    id: 'ostfoldbanen',
    name: 'Østfoldbanen',
    color: '#ff00d0',
    tier: 'trunk',
    serviceLineIds: ['VYG:Line:RE20', 'VYG:Line:R22'],
    stops: ['Oslo S', 'Ski', 'Halden'],
    polyline: [
      S('Oslo S'), P(40, 66), P(43, 69),
      S('Ski'), P(43, 75),
      S('Halden'),
    ],
    dashed: [P(46, 78), P(49, 81)],
  },
];

// ── Build & write ───────────────────────────────────────────────────────────

function build() {
  const stations = {};
  for (const [name, st] of Object.entries(STATIONS)) {
    for (const id of st.ids) {
      stations[id] = {
        name, x: st.x, y: st.y, lat: st.lat, lon: st.lon,
        bnCode: st.bnCode ?? null,
        lines: [], interchange: false,
      };
    }
  }

  const lines = LINES.map(ln => {
    // Include ALL NSR alias IDs for each stop so placeOnSchematic can match
    // journeys that use any of the alternative IDs for the same station.
    const stationIds = ln.stops.flatMap(name => {
      const st = STATIONS[name];
      if (!st) throw new Error(`Line ${ln.id} references unknown station "${name}"`);
      return st.ids;
    });
    for (const name of ln.stops) {
      for (const id of STATIONS[name].ids) stations[id].lines.push(ln.id);
    }
    // Normalise polyline + dashed to schematic coords (already y-flipped via
    // S() and P() helpers).
    return {
      id: ln.id,
      name: ln.name,
      color: ln.color,
      tier: ln.tier,
      serviceLineIds: ln.serviceLineIds,
      stations: stationIds,
      polyline: ln.polyline.map(p => ({ x: p.x, y: p.y, ...(p.station ? { station: STATIONS[p.station].ids[0] } : {}) })),
      dashed: ln.dashed ? ln.dashed.map(p => ({ x: p.x, y: p.y })) : undefined,
    };
  });

  for (const station of Object.values(stations)) {
    station.interchange = new Set(station.lines).size > 1;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function fit(p) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  for (const s of Object.values(stations)) fit(s);
  for (const ln of lines) {
    ln.polyline.forEach(fit);
    if (ln.dashed) ln.dashed.forEach(fit);
  }
  const padX = (maxX - minX) * 0.04;
  const padY = (maxY - minY) * 0.08;

  return {
    bounds: {
      minX: +(minX - padX).toFixed(2),
      minY: +(minY - padY).toFixed(2),
      maxX: +(maxX + padX).toFixed(2),
      maxY: +(maxY + padY).toFixed(2),
    },
    projection: { centerLat: 64.5, centerLon: 12, scale: 1 },
    stations,
    lines,
  };
}

const out = build();
await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT_PATH}`);
console.log(`  lines: ${out.lines.length}`);
console.log(`  unique stations: ${Object.keys(STATIONS).length}`);
console.log(`  station-id entries: ${Object.keys(out.stations).length}`);
console.log(`  interchanges: ${Object.values(out.stations).filter(s => s.interchange).length}`);
console.log(`  bounds: ${JSON.stringify(out.bounds)}`);
