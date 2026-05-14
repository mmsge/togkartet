export const map = L.map('map', {
  crs: L.CRS.Simple,
  center: [0, 0],
  zoom: 1,
  zoomControl: true,
  minZoom: -2,
  maxZoom: 5,
  zoomDelta: 0.5,
  zoomSnap: 0.25,
});
