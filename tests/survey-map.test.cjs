const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const webgis = path.join(__dirname, '..', 'webgis');
const meta = {
  labels: [{ name: 'Potholes', color: '#7f1d1d', is_distress: true }, { name: 'Normal', color: '#16a34a', is_distress: false }],
  severities: [{ name: 'None', radius_px: 4 }, { name: 'High', radius_px: 13 }],
  vlm_classes: [{ name: 'normal', color: '#16a34a' }, { name: 'not_covered', color: '#111827' }]
};
function segment(id = 'drive-a_seg00000', lon = 77.565, lat = 12.93) {
  return {
    type: 'Feature', id,
    geometry: { type: 'Polygon', coordinates: [[[lon - .00002, lat - .00002], [lon + .00002, lat - .00002], [lon + .00002, lat + .00002], [lon - .00002, lat + .00002], [lon - .00002, lat - .00002]]] },
    properties: { layer: 'video', segment_id: id, session_id: 'drive-a', k: 0, centre_lat: lat, centre_lon: lon, length_m: 5, position_sigma_m: 6, vlm_class: 'distress', marker_label: 'Potholes', final_primary_label: 'Potholes', final_severity: 'High', final_labels: ['Potholes'], status: 'send' }
  };
}
const citizen = {
  type: 'Feature', id: 'citizen-1', geometry: { type: 'Point', coordinates: [77.567, 12.931] },
  properties: { layer: 'citizen', id: 'citizen-1', latitude: 12.931, longitude: 77.567, vlm_class: 'normal', marker_label: 'Normal', final_primary_label: 'Normal', final_severity: 'None' }
};
const wards = { type: 'FeatureCollection', features: [{
  type: 'Feature', properties: { WARD_NAME: 'Synthetic test ward', WARD_NO: 1 },
  geometry: { type: 'Polygon', coordinates: [[[77.55, 12.91], [77.59, 12.91], [77.59, 12.95], [77.55, 12.95], [77.55, 12.91]]] }
}] };
function setup(t) {
  const dom = new JSDOM('<!doctype html><div id="map"></div>', {
    url: 'http://localhost/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', event => errors.push(event.error?.message || event.message));
  // Geometry and event routing use real Leaflet. Canvas drawing alone is stubbed;
  // jsdom has no raster surface and these checks make no pixel-rendering claims.
  w.HTMLCanvasElement.prototype.getContext = function () {
    const context = { canvas: this, getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }),
      createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }) };
    for (const method of ['clearRect', 'save', 'restore', 'setTransform', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'rect', 'clip', 'stroke', 'fill', 'setLineDash', 'fillRect', 'drawImage', 'putImageData']) context[method] = () => {};
    return context;
  };
  const container = w.document.getElementById('map');
  Object.defineProperties(container, { clientWidth: { value: 900 }, clientHeight: { value: 600 }, offsetWidth: { value: 900 }, offsetHeight: { value: 600 } });
  w.fetch = async () => ({ ok: true, json: async () => wards });
  for (const file of ['vendor/leaflet.js', 'vendor/leaflet.markercluster.js', 'vendor/leaflet-heat.js', 'map.js']) w.eval(fs.readFileSync(path.join(webgis, file), 'utf8'));
  const selected = [], notices = [];
  const map = new w.SurveyMap('map', { onSelect: feature => selected.push(feature), onNotice: message => notices.push(message) });
  map.setMeta(meta);
  t.after(() => { map.map.remove(); dom.window.close(); assert.deepEqual(errors, [], 'no uncaught browser errors'); });
  return { map, w, selected, notices };
}

test('video-only survey map routes canvas clicks with wards present and ignores accidental citizen data', async t => {
  const { map, w, selected, notices } = setup(t), feature = segment();
  map.setData([feature], [citizen]);
  // Low zoom uses ordinary markers compatible with MarkerCluster.
  const videoCluster = map.groups.video.getLayers()[0];
  assert.equal(videoCluster.getLayers().length, 1);
  assert.ok(videoCluster.getLayers()[0] instanceof w.L.Marker);
  map.map.setView([12.93, 77.565], 18, { animate: false });
  map.setLayers({ wards: true });
  await map.loadWards();
  assert.equal(map.wardRecords.length, 1);
  assert.equal(map.wardRecords[0].stats.segments, 1);
  assert.equal(map.wardRecords[0].stats.citizens, undefined);
  assert.doesNotMatch(map.wardTooltip(map.wardRecords[0]).textContent, /citizen/i);
  assert.equal(map.wardRecords[0].stats.distress, 5);
  assert.equal(map.citizenCanvas, map.canvas);
  map.groups.wards.getLayers()[0].eachLayer(layer => assert.equal(layer._renderer, map.canvas));
  map.groups.video.getLayers()[0].eachLayer(layer => assert.equal(layer._renderer, map.canvas));
  assert.equal(map.groups.citizen.getLayers().length, 0);
  map.setLayers({ citizen: true });
  assert.equal(map.layers.citizen, false, 'video-only map cannot enable a citizen layer');
  map.select(feature);
  assert.equal(map.map.getPane('selection').style.pointerEvents, 'none');
  await new Promise(resolve => setTimeout(resolve, 50));
  map.canvas._onClick(new w.MouseEvent('click', { clientX: 450, clientY: 300, bubbles: true }));
  assert.equal(selected.at(-1)?.properties.segment_id, feature.properties.segment_id);
  assert.equal(notices.length, 0);
});

test('survey map clears selection and handles missing or point geometry', t => {
  const { map } = setup(t), feature = segment();
  map.setData([feature], []);
  map.select(feature);
  assert.ok(map.groups.selection.getLayers().length >= 2);
  map.select(null);
  assert.equal(map.groups.selection.getLayers().length, 0);
  map.map.setView([12.93, 77.565], 18, { animate: false });
  const point = { ...feature, geometry: { type: 'Point', coordinates: [77.565, 12.93] } };
  map.setData([point], []);
  assert.equal(map.groups.video.getLayers().length, 1);
  assert.ok(map.groups.video.getLayers()[0] instanceof map.DiamondMarker);
  map.setData([{ type: 'Feature', id: 'missing', geometry: null, properties: { layer: 'video' } }], []);
  assert.equal(map.groups.video.getLayers().length, 0);
  assert.doesNotThrow(() => map.select({ type: 'Feature', geometry: null, properties: {} }));
  assert.equal(map.groups.selection.getLayers().length, 0);
});

test('survey map keeps drive colours stable and respects metadata and layer visibility', t => {
  const { map } = setup(t);
  const track = { type: 'LineString', coordinates: [[77.565, 12.93], [77.566, 12.931]] };
  const a = { session_id: 'drive-a', track }, b = { session_id: 'drive-b', track };
  map.setSessions([a, b]);
  const before = map.groups.track.getLayers()[1].getLayers()[0].options.color;
  map.setSessions([b]);
  assert.equal(map.groups.track.getLayers()[0].getLayers()[0].options.color, before);
  const feature = segment();
  assert.equal(map.featureRadius(feature), 13);
  assert.equal(map.featureColor(feature), '#7f1d1d');
  assert.equal(map.featureColor({ properties: { ...feature.properties, status: 'not_covered', vlm_class: 'normal' } }), '#111827');
  map.setData([feature], [citizen], [{ ...feature, geometry: track }]);
  map.setLayers({ coverage: true, heat: true });
  assert.equal(map.groups.coverage.getLayers().length, 1);
  assert.equal(map.groups.heat.getLayers()[0]._latlngs.length, 1);
  map.setLayers({ video: false, citizen: false });
  assert.equal(map.groups.heat.getLayers()[0]._latlngs.length, 0);
  const basemap = map.basemap;
  map.setTheme('light');
  assert.equal(map.basemap, basemap, 'setting the existing theme should not reload tiles');
});
