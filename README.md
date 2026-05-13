# Noregstoget — Live Norwegian Train Map

A proof-of-concept web app that shows all passenger trains in Norway on a live map.
Trains update their position every 15 seconds. Clicking a train opens a detail panel
with route, operator, direction, stops, and delay information.

## Live URL

```
https://mmsge.github.io/togkartet/
```

## Run locally

Do **not** open `index.html` directly as a `file://` URL — browsers block
cross-origin fetches from the file protocol.

Instead, serve from localhost:

```bash
# Python 3
python3 -m http.server 8080

# or Node
npx serve .
```

Then open `http://localhost:8080` in your browser.

## Deploy

Push to `main` — GitHub Actions handles the rest.

First deploy requires a one-time setup:
1. Go to **Settings → Pages** in the repository.
2. Set **Source** to **GitHub Actions**.
3. Subsequent pushes to `main` deploy automatically.

## Data sources

| Source | URL |
|---|---|
| Vehicle positions (GTFS-RT) | https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions |
| Journey planner (GraphQL) | https://api.entur.io/journey-planner/v3/graphql |
| Base map | https://www.openstreetmap.org/ |
| Railway overlay | https://www.openrailwaymap.org/ |

All Entur APIs are open (no API key required) and CORS-enabled for browser use.

## Known limitations

- 15-second update interval (dictated by feed cadence).
- Not all trains have GPS — some may not appear.
- No rolling stock or platform detail yet.
- OpenRailwayMap tiles can load slowly at low zoom levels.

## Licence

MIT
