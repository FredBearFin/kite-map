// Reference kite spots and schools. Locations are approximate (lake or beach
// level, not exact launch points). Used as a map layer, as forecast targets,
// and to check that the scoring ranks real kite spots well.

export const KNOWN_SPOTS = [
  { name: 'West Okoboji Lake', lat: 43.375, lon: -95.155, region: 'Iowa Great Lakes', note: 'Active local kite crew. Deep, clear water.' },
  { name: 'Big Spirit Lake', lat: 43.47, lon: -95.1, region: 'Iowa Great Lakes', note: 'Largest natural lake in Iowa, open to most winds.' },
  { name: 'Lake Okamanpeedan (Tuttle Lake)', lat: 43.505, lon: -94.67, region: 'Iowa / Minnesota border', note: 'Shallow prairie lake.' },
  { name: 'Branched Oak Lake', lat: 40.97, lon: -96.86, region: 'Lincoln, Nebraska', note: 'Closest larger reservoir to Omaha and Lincoln.' },
  { name: 'Lake McConaughy', lat: 41.25, lon: -101.72, region: 'Western Nebraska', note: 'Big reservoir with sand beaches.' },
  { name: 'Lake Waconia', lat: 44.865, lon: -93.785, region: 'Minneapolis area', note: 'Lakawa teaching lake.', school: 'Lakawa' },
  { name: 'Mille Lacs Lake', lat: 46.23, lon: -93.65, region: 'Central Minnesota', note: 'Lakawa teaching lake. Huge, popular for snowkiting in winter.', school: 'Lakawa' },
  { name: 'White Bear Lake', lat: 45.08, lon: -92.985, region: 'St. Paul area', note: 'Lakawa teaching lake.', school: 'Lakawa' },
  { name: 'Medicine Lake', lat: 45.005, lon: -93.415, region: 'Minneapolis area', note: 'Lakawa teaching lake.', school: 'Lakawa' },
  { name: 'South Padre Island (Laguna Madre flats)', lat: 26.13, lon: -97.18, region: 'Texas Gulf Coast', note: 'Waist-deep bay water, steady wind. Schools: H2O Sports, Air Padre.', school: 'H2O Sports, Air Padre' },
  { name: 'Bird Island Basin', lat: 27.475, lon: -97.31, region: 'Padre Island National Seashore', note: 'Shallow Laguna Madre launch, popular for learning.' },
];
