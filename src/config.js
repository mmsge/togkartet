export const CONFIG = {
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
