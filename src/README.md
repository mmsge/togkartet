# src/ — ES module sources

No bundler. GitHub Pages serves these files directly; `index.html` loads
`src/main.js` as `type="module"`.

## Module graph

```
config.js        — CONFIG constant and operator colours (no deps)
gtfs.js          — initProto, fetchVehiclePositions, isTrain, operatorCodeFrom, isLineRef
                   imports: config
journey.js       — fetchJourney, journeyCache, journeyFetchQueue, processJourneyFetchQueue
                   imports: config
detail-panel.js  — openPanel, closePanel, renderJourney, escHtml, fmt, delayMinutes
                   imports: config
schematic.js     — map (Leaflet instance), loadNetwork, placeOnSchematic, network (live binding)
                   imports: detail-panel (escHtml for station labels)
station-popup.js — openStationPopup, closeStationPopup, prefetchStopBoards
                   imports: config, schematic (map + network), detail-panel (escHtml)
train-markers.js — updateMarkers, onMarkerClick, trainMarkers, createTrainIcon
                   imports: config, schematic, journey, gtfs, detail-panel, station-popup
theme.js         — dark-mode toggle button, DOM side-effects only (no deps, no exports)
main.js          — boot sequence, refresh loop, status bar
                   imports: everything above
```

## Key design decisions

- **No circular dependencies.** `schematic.js` exposes `setStationClickHandler` so
  `main.js` can wire `openStationPopup` after both modules load, instead of having
  `schematic` import `station-popup`.
- **Live bindings for shared state.** `network` (schematic) and `journeyFetchQueue`
  (journey) are exported `let`/`const` whose contents are mutated in place, so
  all importers always see the current value without any event bus.
- `escHtml` lives in `detail-panel.js` and is re-exported to the three modules
  that need it (schematic, station-popup, train-markers).
