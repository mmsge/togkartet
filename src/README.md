# src/ — ES module sources

No bundler. GitHub Pages serves these files directly; `index.html` loads
`src/main.js` as `type="module"`.

## Module graph

```
map.js           — Leaflet map instance (no deps)
config.js        — CONFIG constant and operator colours (no deps)
gtfs.js          — initProto, fetchVehiclePositions, isTrain, operatorCodeFrom, isLineRef
                   imports: config
journey.js       — fetchJourney, journeyCache, journeyFetchQueue, processJourneyFetchQueue
                   imports: config
detail-panel.js  — openPanel, closePanel, renderJourney, escHtml, fmt, delayMinutes
                   imports: config
station-popup.js — openStationPopup, closeStationPopup, prefetchStopBoards(network)
                   imports: map, config, detail-panel
schematic.js     — loadNetwork, placeOnSchematic, network (live binding); re-exports map
                   imports: map, detail-panel, station-popup
train-markers.js — updateMarkers, onMarkerClick, createTrainIcon, trainMarkers
                   imports: config, schematic, journey, gtfs, detail-panel, station-popup
theme.js         — dark-mode toggle button, DOM side-effects only (no deps, no exports)
main.js          — boot sequence, refresh loop, status bar
                   imports: config, gtfs, schematic, station-popup, train-markers
```

## Key design decisions

- **No circular dependencies.** `map.js` is a leaf module with no imports, which lets
  `station-popup.js` import `map` without touching `schematic.js`. This means
  `schematic.js` can import `openStationPopup` directly — no wiring helpers needed.
- **Live bindings for shared state.** `network` (schematic) and `journeyFetchQueue`
  (journey) are exported `let`/`const` whose contents are mutated in place, so
  all importers always see the current value without any event bus.
- **`prefetchStopBoards(network)`** receives the network object as a parameter from
  `main.js` (which holds the live binding from schematic), keeping station-popup
  free of any schematic dependency.
- `escHtml` lives in `detail-panel.js` and is imported by the three modules that
  need it (schematic, station-popup, train-markers).
