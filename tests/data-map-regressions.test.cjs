const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const D = require('../webgis/data.js');
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '../gis_sample/api/gis/meta.json')));

const feature = (id, properties = {}, geometry = { type: 'Point', coordinates: [77.565, 12.93] }) => ({
  type: 'Feature', id, geometry, properties: { layer: 'video', segment_id: id, centre_lon: 77.565, centre_lat: 12.93,
    vlm_class: 'normal', status: 'send', final_labels: ['Normal'], final_primary_label: 'Normal',
    final_severity: 'None', position_sigma_m: 6, ...properties }
});
const response = data => ({ ok: true, status: 200, json: async () => data });
const page = (features, total = features.length, extra = {}) => ({ schema: 'geoai.gis.v1', features, numberMatched: total, numberReturned: features.length, ...extra });

test('metadata rejects malformed taxonomy and accepts additive contract fields', () => {
  assert.equal(D.validateMeta(meta), meta);
  assert.doesNotThrow(() => D.validateMeta({ ...meta, future: { expanded: true } }));
  assert.throws(() => D.validateMeta({ ...meta, confidence_threshold: null }), /metadata/);
  assert.throws(() => D.validateMeta({ ...meta, labels: [...meta.labels, meta.labels[0]] }), /labels metadata/);
  assert.throws(() => D.validateMeta({ ...meta, labels: [{ ...meta.labels[0], color: '#12345' }] }), /labels metadata/);
  assert.throws(() => D.validateMeta({ ...meta, severities: [{ name: 'Low', radius_px: -2 }] }), /severities metadata/);
});

test('client preview does not conflate image absence with Normal and respects layer-specific filters', () => {
  const skipped = feature('skipped', { vlm_class: 'not_sent', status: 'skip', final_labels: [], confidence: null });
  const pending = feature('pending', { vlm_class: 'pending', final_labels: [], confidence: null });
  assert.ok(D.matches(skipped, { status: 'skip' }, meta, 'video'));
  assert.ok(!D.matches(skipped, { vlm_class: 'normal' }, meta, 'video'));
  assert.ok(!D.matches(pending, { highConfidence: true }, meta, 'video'));
  assert.ok(!D.matches(skipped, { date_from: '2026-10-26' }, meta, 'video'));
  const missing = { status: 'not_covered', vlm_class: 'normal', marker_label: 'Normal' };
  assert.equal(D.color(missing, meta), meta.vlm_classes.find(c => c.name === 'not_covered').color);
  const citizen = feature('photo', { layer: 'citizen', created_at: '2026-10-26T18:30:00Z', assessment_status: 'expert_review' });
  assert.ok(!D.matches(citizen, {}, meta, 'citizen'));
  assert.ok(D.matches(citizen, { include_review: true, status: 'skip', session: 'elsewhere', date_from: '2026-10-27', date_to: '2026-10-27' }, meta, 'citizen'));
  assert.ok(!D.matches(citizen, { include_review: true, date_to: '2026-10-26' }, meta, 'citizen'));
});

test('paging rejects changing totals, missing IDs, excess rows and incorrect returned count', async t => {
  let call = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => response(page([feature(String(call++))], call === 1 ? 3 : 2)));
  await assert.rejects(D.fetchPages('/gis/video/segments.geojson', {}, { pageSize: 1 }), /changed during loading/);
  mock.mock.mockImplementation(async () => response(page([{ type: 'Feature', geometry: null, properties: {} }])));
  await assert.rejects(D.fetchPages('/gis/video/segments.geojson'), /without an identifier/);
  mock.mock.mockImplementation(async () => response(page([feature('a'), feature('b')])));
  await assert.rejects(D.fetchPages('/gis/video/segments.geojson', {}, { pageSize: 1 }), /invalid feature page/);
  mock.mock.mockImplementation(async () => response(page([feature('a')], 1, { numberReturned: 2 })));
  await assert.rejects(D.fetchPages('/gis/video/segments.geojson'), /invalid feature count/);
  mock.mock.mockImplementation(async () => response(page([], 1)));
  const pastEnd = await D.fetchPages('/gis/video/segments.geojson', new URLSearchParams({ offset: '10' }));
  assert.equal(pastEnd.features.length, 0);
  assert.equal(pastEnd.truncated, false);
});

function setupMap(t, width = 900, height = 600) {
  const dom = new JSDOM('<!doctype html><div id="map"></div>', { url: 'http://localhost/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = function () {
    const ctx = { canvas: this, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
    for (const key of ['clearRect','save','restore','setTransform','translate','scale','beginPath','moveTo','lineTo','arc','closePath','rect','clip','stroke','fill','setLineDash','fillRect','drawImage']) ctx[key] = () => {};
    return ctx;
  };
  const container = w.document.getElementById('map');
  for (const [key,value] of Object.entries({ clientWidth: width, clientHeight: height, offsetWidth: width, offsetHeight: height })) Object.defineProperty(container,key,{value});
  for (const file of ['vendor/leaflet.js','vendor/leaflet.markercluster.js','map.js']) w.eval(fs.readFileSync(path.join(__dirname,'../webgis',file),'utf8'));
  const anchors = [], invalidations = [];
  const map = new w.SurveyMap('map', { onSelectionMove: point => anchors.push(point), onSelectionInvalidated: () => invalidations.push(true) });
  map.setMeta(meta);
  t.after(() => { map.map.remove(); dom.window.close(); });
  return { map, anchors, invalidations, w };
}

test('hiding a selected layer clears its vehicle and uncertainty; coverage can retain a visible video selection', t => {
  const { map, invalidations } = setupMap(t), f = feature('a');
  map.setData([f], []); map.select(f);
  assert.equal(map.groups.selection.getLayers().length, 2);
  map.setLayers({ video: false });
  assert.equal(map.selected, null);
  assert.equal(map.groups.selection.getLayers().length, 0);
  assert.equal(invalidations.length, 1);
  map.setLayers({ coverage: true }); map.select(f);
  assert.equal(map.groups.selection.getLayers().length, 2);
  map.setLayers({ coverage: false });
  assert.equal(map.groups.selection.getLayers().length, 0);
});

test('anchor follows the map and playback selections never reset a user zoom', t => {
  const { map, anchors } = setupMap(t), f = feature('a');
  map.map.setView([12.93, 77.565], 18, { animate: false });
  map.select(f, { focus: true, pan: true });
  let anchor = map.anchorFor(f);
  assert.equal(anchor.x, 450); assert.equal(anchor.y, 300); assert.equal(anchor.visible, true);
  assert.equal(map.map.getZoom(), 18);
  map.map.setView([12.931, 77.566], 17, { animate: false });
  map.select(f, { pan: true });
  assert.equal(map.map.getZoom(), 17);
  assert.ok(anchors.length > 0);
  assert.ok(Number.isFinite(map.getView().lat)); assert.ok(Number.isFinite(map.getView().lon));
});

test('invalid coordinates are skipped, missing polygons fall back to a valid centre, and Unknown radius uses metadata', t => {
  const { map } = setupMap(t);
  map.map.setView([12.93,77.565],18,{ animate:false });
  const bad = feature('bad', { centre_lat: 500, centre_lon: 999 }, { type:'Point', coordinates:[999,500] });
  const fallback = feature('fallback', {}, { type:'Polygon', coordinates:[] });
  assert.doesNotThrow(() => map.setData([bad, fallback], []));
  assert.equal(map.groups.video.getLayers().length, 1);
  assert.equal(map.anchorFor(bad), null);
  const varied = { ...meta, severities: [...meta.severities.filter(s => s.name !== 'Unknown'), { name:'Unknown',radius_px:7 }] };
  map.setMeta(varied);
  assert.equal(map.featureRadius({ properties:{ final_severity:'Missing' } }),7);
});


test('phone playback pans the vehicle into the measured map area above the compact card without changing zoom', t => {
  const { map, w } = setupMap(t, 375, 812), f = feature('phone');
  const panel = w.document.createElement('aside'); panel.id = 'detailPanel';
  panel.getBoundingClientRect = () => ({ x:16,y:369,left:16,top:369,right:359,bottom:501,width:343,height:132 });
  const strip = w.document.createElement('section'); strip.id = 'stripPanel';
  strip.getBoundingClientRect = () => ({ x:16,y:505,left:16,top:505,right:359,bottom:731,width:343,height:226 });
  w.document.body.append(panel,strip);
  map.map.setView([12.93,77.565],17,{ animate:false });
  map.select(f,{pan:true});
  const anchor = map.anchorFor(f);
  assert.ok(anchor.x >= 20 && anchor.x <= 313, 'vehicle avoids right tools');
  assert.ok(anchor.y >= 24 && anchor.y <= 349, 'vehicle is above the compact evidence card');
  assert.ok(Math.abs(anchor.y-186.5)<=1, 'vehicle is recentered in the usable map area');
  assert.equal(map.map.getZoom(),17);
  panel.hidden = true;strip.hidden = true;
  map.map.setView([12.93,77.565],17,{ animate:false });
  map.select(f,{pan:true});
  assert.equal(map.anchorFor(f).y,406,'hidden panels do not shrink the usable map');
});

test('first phone selection rechecks newly revealed evidence after the application renders it', async t => {
  const { map, w } = setupMap(t, 375, 812), f = feature('first-phone');
  const panel=w.document.createElement('aside');panel.id='detailPanel';panel.hidden=true;
  panel.getBoundingClientRect=()=>({left:16,top:369,right:359,bottom:501,width:343,height:132});
  w.document.body.append(panel);
  map.map.setView([12.93,77.565],17,{animate:false});
  map.select(f,{pan:true});
  assert.equal(map.anchorFor(f).y,406);
  panel.hidden=false;
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.ok(map.anchorFor(f).y<=349,'newly rendered evidence must not cover the selected vehicle');
  assert.equal(map.map.getZoom(),17);
});


test('inset map anchors use viewport coordinates and phone following measures overlapping panels relative to that map', t => {
  const { map, w } = setupMap(t, 351, 514), f = feature('inset');
  map.map.getContainer().getBoundingClientRect=()=>({left:12,top:286,right:363,bottom:800,width:351,height:514});
  const header=w.document.createElement('header');header.className='topbar';
  header.getBoundingClientRect=()=>({left:16,top:16,right:359,bottom:82,width:343,height:66});
  const panel=w.document.createElement('aside');panel.id='detailPanel';
  panel.getBoundingClientRect=()=>({left:24,top:437,right:351,bottom:545,width:327,height:108});
  const strip=w.document.createElement('section');strip.id='stripPanel';
  strip.getBoundingClientRect=()=>({left:24,top:555,right:351,bottom:740,width:327,height:185});
  w.document.body.append(header,panel,strip);
  map.map.setView([12.93,77.565],17,{animate:false});
  const initial=map.anchorFor(f);
  assert.equal(initial.x,initial.localX+12);assert.equal(initial.y,initial.localY+286);
  assert.equal(map.availableViewport({includeDetail:true}).top,24,'header above inset map is not a map obstruction');
  map.select(f,{pan:true});
  const anchor=map.anchorFor(f);
  assert.ok(anchor.y>=310&&anchor.y<=417,'car stays below map top and above the compact card');
  assert.ok(anchor.x>=32&&anchor.x<=301,'car stays clear of inset map tools');
  assert.equal(map.map.getZoom(),17);
});

test('inset fit padding reserves only controls overlapping the map and video-only ward data cannot count photos', t => {
  const { map, w }=setupMap(t,351,514);
  map.map.getContainer().getBoundingClientRect=()=>({left:12,top:286,right:363,bottom:800,width:351,height:514});
  const drive=w.document.createElement('section');drive.id='driveControl';
  drive.getBoundingClientRect=()=>({left:24,top:298,right:268,bottom:468,width:244,height:170});
  w.document.body.append(drive);
  assert.equal(map.availableViewport().top,200,'drive selector inside map reserves its height');
  drive.hidden=true;
  assert.equal(map.availableViewport().top,24,'hidden drive selector reserves no map space');
  const video=feature('video'),photo=feature('photo',{layer:'citizen'});
  map.setData([video,photo],[photo]);map.setLayers({citizen:true});
  assert.equal(map.video.length,1);assert.equal(map.citizen.length,0);assert.equal(map.layers.citizen,false);
  assert.equal(map.groups.citizen.getLayers().length,0);
});
