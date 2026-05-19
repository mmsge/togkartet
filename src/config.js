export const CONFIG = {
  enturClientName: 'noregstoget-poc',
  vehiclePositionsUrl: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
  siriVmUrl: 'https://api.entur.io/realtime/v1/rest/vm',
  journeyPlannerUrl: 'https://api.entur.io/journey-planner/v3/graphql',
  updateIntervalMs: 15000,
  trainCodespaces: ['VYG', 'SJN', 'SJV', 'GOA', 'GJB', 'FLT', 'RUT', 'NSB'],
  // Lines absent from the GTFS-RT vehicle-positions feed that need targeted
  // SIRI-VM LineRef requests to surface their trains.
  supplementaryLineRefs: [
    'SJN:Line:21',  // Dovrebanen (SJN)
    'SJN:Line:22',  // Raumabanen
    'SJN:Line:25',  // Rørosbanen
    'SJN:Line:26',  // Trønderbanen
    'SJN:Line:71',  // Nordlandsbanen
    'SJN:Line:72',  // Meråkerbanen
    'SJN:Line:79',  // Saltenpendelen
    'VYG:Line:R45', // Flåmsbana
  ],
  operatorColors: {
    VYG: '#e4032e',
    SJN: '#0e7dc2',
    SJV: '#d8202f',
    GOA: '#00a651',
    GJB: '#8b4513',
    FLT: '#6a0dad',
    RUT: '#e60000',
    NSB: '#e4032e',
    DEFAULT: '#555555',
  },
};
