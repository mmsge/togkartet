# Noregstoget — Live Norwegian Train Map

A schematic, London-Tube-style map of the Norwegian passenger rail network.
Lines are drawn as straight schematic segments with stations spaced roughly
proportional to real distance. Live train positions are overlaid on the
schematic — vehicles slide along the lines as they move between stops.
Clicking a train opens a detail panel with route, operator, direction, stops,
and delay information.

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

## Rebuilding the schematic topology

The schematic network layout lives in `data/network.json` and is generated
once by a one-shot Node script. Re-run it if Entur adds new lines or
stations, or after editing the bootstrap script's algorithm:

```bash
node tools/build-network.mjs
```

The script:

1. Lists every Norwegian rail line from Entur Journey Planner.
2. Filters to a curated allowlist (`LINE_CONFIG`) — about 26 canonical
   passenger lines, with duplicate express variants and cross-border
   services dropped. Each line is also tagged with a `tier`
   (`trunk` / `regional` / `commuter` / `branch`) so the app can show or
   hide it depending on zoom.
3. Picks the longest non-replacement service journey on each as the
   canonical stop sequence; clips stops to the Norway bounding box so
   cross-border services like RE20 don't drag the schematic into Sweden.
4. Projects stop lat/lon to a schematic coordinate space (equirectangular,
   centred on Norway).
5. Straightens each line by fitting a principal-axis line through its stops
   (PCA), preserving real-distance spacing.
6. Drops single-line commuter intermediate stops (L1 / L2 inner-Oslo dots
   that don't transfer to a regional line and aren't terminals) — about
   45 of them.
7. Resolves topological junctions (stations where lines actually diverge)
   by averaging positions across incident lines. Long-distance backbones
   like Bergensbanen and Dovrebanen own shared station positions; shorter
   local services defer to them.
8. Applies hand-authored `OSLO_OVERRIDES`: the central tube and immediate
   surroundings (Oslo S, NT, Skøyen, Lysaker, Stabekk, Sandvika, Asker,
   Spikkestad, Drammen, Hokksund, Tøyen + Gjøvikbanen first stops,
   Strømmen, Lillestrøm, Holmlia/Kolbotn/Ski) get explicit hand-placed
   positions, then every line is re-interpolated through them so non-
   overridden stops slide smoothly between the anchors.
9. Writes `data/network.json` (~95 KB, ~26 lines, ~280 stations).

To tweak the schematic by hand, you can either:

- edit `LINE_CONFIG` (add/remove lines, change colours or tiers) and re-run, or
- edit `OSLO_OVERRIDES` (move anchor positions in the central area) and re-run, or
- post-edit `data/network.json` directly for one-off nudges. The data file is
  the source of truth at runtime — the bootstrap script doesn't run on every load.

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
| Vehicle positions fallback (SIRI-VM) | https://api.entur.io/realtime/v1/rest/vm |
| Journey planner (GraphQL) | https://api.entur.io/journey-planner/v3/graphql |
| Norway coastline outline | [Natural Earth 1:110m countries](https://www.naturalearthdata.com/) (via [martynafford/natural-earth-geojson](https://github.com/martynafford/natural-earth-geojson)) |

All Entur APIs are open (no API key required) and CORS-enabled for browser use.

## Known limitations

- 15-second update interval (dictated by feed cadence).
- Not all trains have GPS — some may not appear.
- A few lines (notably RE10 / Hovedbanen between Lillestrøm and Hamar) still
  have visible kinks where override anchors hand off to auto-positioned
  stations; extend `OSLO_OVERRIDES` to smooth them out.
- Station labels can overlap in dense urban clusters at moderate zoom. Only
  terminals + interchanges show at intermediate zoom; everything shows once
  you zoom in to z ≥ 3.

## Licence

MIT
