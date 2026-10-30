const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'webgis');
const SCHEMA = 'geoai.gis.v1';
const bbox = [77.56, 12.92, 77.57, 12.94];
const classes = ['distress', 'normal', 'unknown', 'pending', 'not_sent', 'not_covered'];
const meta = {
  schema: SCHEMA,
  labels: [
    { name: 'Potholes', category: 'Disintegration', color: '#7f1d1d', is_distress: true, marker_priority: 1 },
    { name: 'Normal', category: 'Normal', color: '#16a34a', is_distress: false, marker_priority: 2 },
  ],
  categories: ['Disintegration', 'Normal'],
  severities: ['None', 'Low', 'Medium', 'High', 'Unknown'].map((name, index) => ({ name, radius_px: index + 4 })),
  statuses: ['send', 'audit', 'skip', 'not_covered'].map(name => ({ name, meaning: name })),
  vlm_classes: classes.map(name => ({ name, meaning: name, color: name === 'normal' ? '#16a34a' : '#6b7280' })),
  confidence_threshold: 0.8,
  preview_widths: [480, 1280],
  limits: { default_limit: 5000, max_limit: 20000 },
  video: { sessions: 1, segments: 5, bbox },
};

function segment(index, changes = {}) {
  const id = `drive-a_seg${String(index).padStart(5, '0')}`;
  return {
    type: 'Feature', id, geometry: { type: 'Point', coordinates: [77.565 + index * .00001, 12.93] },
    properties: {
      layer: 'video', segment_id: id, session_id: 'drive-a', k: index,
      s0_m: index * 5, s1_m: (index + 1) * 5, length_m: 5,
      status: 'send', vlm_class: 'distress', answered: true,
      final_labels: ['Potholes'], final_primary_label: 'Potholes', marker_label: 'Potholes', final_severity: 'High',
      labels: ['Potholes'], severity: 'High', confidence: .92,
      has_image: true, thumb_url: `/gis/image/${id}?w=480`, preview_url: `/gis/image/${id}?w=1280`, image_url: `/gis/image/${id}`,
      utc: '2026-10-27T05:00:00Z', local_time: '2026-10-27T10:30:00+05:30',
      centre_lat: 12.93, centre_lon: 77.565 + index * .00001, position_sigma_m: 6,
      road_name: 'Test road', road_id: 'TST-1', lane: 'L1', direction: 'increasing_chainage', device_model: 'Test camera',
      needs_expert_review: false, expert_reviewed: false, description: 'No visible distress.',
      gate_mode: 'all', gate_decision_if_gated: 'skip', quality_reason: 'sharpest', quality_sharpness: .05,
      ...changes,
    },
  };
}

function videoFixtures() {
  return [
    segment(0, { vlm_class: 'distress', final_labels: ['Potholes'], labels: ['Potholes'], final_primary_label: 'Potholes', marker_label: 'Potholes', final_severity: 'High', severity: 'High', confidence: .65, needs_expert_review: true, description: 'A pothole needs inspection.' }),
    segment(1,{vlm_class:'normal',final_labels:['Normal'],final_primary_label:'Normal',marker_label:'Normal',final_severity:'None',labels:['Normal'],severity:'None'}),
    segment(2, { vlm_class: 'pending', answered: false, final_labels: [], labels: [], final_primary_label: null, marker_label: null, final_severity: 'Unknown', confidence: null, description: '' }),
    segment(3, { status: 'skip', vlm_class: 'not_sent', answered: false, final_labels: [], labels: [], final_primary_label: null, marker_label: null, final_severity: 'Unknown', confidence: null, has_image: false, image_url: null, preview_url: null, thumb_url: null, description: '' }),
    segment(4, { status: 'not_covered', vlm_class: 'not_covered', answered: false, final_labels: [], labels: [], final_primary_label: null, marker_label: null, final_severity: 'Unknown', confidence: null, has_image: false, image_url: null, preview_url: null, thumb_url: null, utc: null, local_time: null, description: '' }),
  ];
}

function matches(feature, params) {
  const p = feature.properties;
  for (const key of ['session', 'status', 'vlm_class', 'severity']) {
    const value = params.get(key);
    const prop = key === 'session' ? p.session_id : key === 'severity' ? p.final_severity : p[key];
    if (value && !value.split(',').includes(prop)) return false;
  }
  if (params.get('label') && !params.get('label').split(',').some(label => p.final_labels.includes(label))) return false;
  if (params.get('needs_review') === 'true' && !p.needs_expert_review) return false;
  if (params.get('reviewed') === 'true' && !p.expert_reviewed) return false;
  if (params.has('min_confidence') && (p.confidence == null || p.confidence < Number(params.get('min_confidence')))) return false;
  const when = Date.parse(p.utc || p.created_at);
  if (params.get('date_from') && (!Number.isFinite(when) || when < Date.parse(params.get('date_from')))) return false;
  if (params.get('date_to') && (!Number.isFinite(when) || when >= Date.parse(params.get('date_to')))) return false;
  return true;
}

function summary(features) {
  const metres = predicate => features.filter(predicate).reduce((n, f) => n + f.properties.length_m, 0);
  const surveyed = metres(f => f.properties.status !== 'not_covered');
  const distress = metres(f => f.properties.vlm_class === 'distress');
  const classified = metres(f => ['distress', 'normal'].includes(f.properties.vlm_class));
  return { schema: SCHEMA, sessions: features.length ? 1 : 0, segments: features.length, bbox,
    route_m: metres(() => true), surveyed_m: surveyed, not_covered_m: metres(f => f.properties.status === 'not_covered'),
    classified_m: classified, distress_m: distress, normal_m: classified - distress,
    answered: features.filter(f => f.properties.answered).length, needs_expert_review: features.filter(f => f.properties.needs_expert_review).length,
    expert_reviewed: 0, pct_distress_of_surveyed: surveyed ? distress / surveyed * 100 : 0,
    pct_distress_of_classified: classified ? distress / classified * 100 : 0,
    labels: meta.labels.map(label => ({ label: label.name, segments: features.filter(f => f.properties.final_labels.includes(label.name)).length,
      length_m: metres(f => f.properties.final_labels.includes(label.name)),
      pct_of_surveyed: surveyed ? metres(f => f.properties.final_labels.includes(label.name)) / surveyed * 100 : 0 })),
    segments_by_status: Object.fromEntries(meta.statuses.map(({ name }) => [name, features.filter(f => f.properties.status === name).length])),
    segments_by_vlm_class: Object.fromEntries(classes.map(name => [name, features.filter(f => f.properties.vlm_class === name).length])),
  };
}

function session(features) {
  return { ...summary(features), session_id: 'drive-a', state: 'stored', road_name: 'Test road', road_id: 'TST-1',
    local_date: '2026-10-27', start_utc: '2026-10-27T05:00:00Z', end_utc: '2026-10-27T05:10:00Z',
    per_km: [{ km: 0, from_m: 0, to_m: 1000, surveyed_m: 20, classified_m: 10, distress_m: 5, not_covered_m: 5, labels_m: { Potholes: 5, Normal: 5 } }],
    track: { type: 'LineString', coordinates: [[77.565, 12.93], [77.566, 12.932]] } };
}

async function settle() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); }

async function boot(t, options = {}) {
  const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), { url: options.url || 'https://example.test/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  let now = 0, timerId = 0;
  const timers = new Map();
  if (options.fakeClock) {
    w.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
    w.clearTimeout = id => timers.delete(id);
  }
  function advance(ms) {
    assert.ok(options.fakeClock);
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  }
  const imageRequests = [], imageNodes = [];
  const imageSrc = Object.getOwnPropertyDescriptor(w.HTMLImageElement.prototype, 'src');
  Object.defineProperty(w.HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return imageSrc.get.call(this); },
    set(value) {
      imageRequests.push(String(value)); imageNodes.push(this);
      imageSrc.set.call(this, value);
      if (options.autoImages) queueMicrotask(() => this.dispatchEvent(new w.Event('load')));
    },
  });
  const errors = [];
  w.console = { log() {}, warn() {}, error(...args) { errors.push(args); } };
  const dialogOpens=[];
  // jsdom lacks the native modal focus boundary. Match the browser rule that
  // an open modal blocks focusing its background until dialog.close() runs.
  let activeModal=null;
  const nativeFocus=w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus=function(...args){if(activeModal?.open&&this!==activeModal&&!activeModal.contains(this))return;return nativeFocus.apply(this,args);};
  w.HTMLDialogElement.prototype.show = function () { this.open=true;dialogOpens.push({id:this.id,modal:false});this.querySelector('button,input,select')?.focus(); };
  w.HTMLDialogElement.prototype.showModal = function () { this.open=true;activeModal=this;dialogOpens.push({id:this.id,modal:true});this.querySelector('button,input,select')?.focus(); };
  w.HTMLDialogElement.prototype.close = function () { if(!this.open)return;this.open=false;if(activeModal===this)activeModal=null;queueMicrotask(()=>this.dispatchEvent(new w.Event('close'))); };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function (options) { this.scrollLeft = options?.left || 0; this.dispatchEvent(new w.Event('scroll')); };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = query => ({ matches:Boolean(options.reducedMotion)&&query.includes('prefers-reduced-motion'),media:query,addEventListener() {},removeEventListener() {} });
  if(options.fakeClock){w.requestAnimationFrame=fn=>w.setTimeout(()=>fn(now),16);w.cancelAnimationFrame=id=>w.clearTimeout(id);}
  w.open = (...args) => { opened.push(args); };
  w.print = () => {};
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  const opened = [];
  const requests = [];
  t.after(()=>assert.equal(requests.some(r=>r.url.pathname.includes('/citizen/')),false,'the video app must never request citizen data'));
  const video = options.video || videoFixtures();
  const sessions = options.sessions || [session(video)];
  const response = data => ({ ok: true, status: 200, json: async () => data });
  const defaultFetch = async input => {
    const url = new URL(input, w.location.href);
    const params = url.searchParams;
    if (url.pathname === '/gis/meta') return response({ ...meta, ...options.meta, video: { ...meta.video, segments: video.length } });
    if (url.pathname === '/gis/video/sessions') return response({ schema: SCHEMA, count: sessions.length, sessions });
    if (url.pathname === '/gis/video/summary') return response(summary(video.filter(f => matches(f, params))));
    if (url.pathname === '/gis/citizen/assessments.geojson') throw new Error('Citizen data is outside this video-only app');
    if (url.pathname === '/gis/video/segments.geojson') {
      const rows = video.filter(f => matches(f, params));
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 5000);
      const features = rows.slice(offset, offset + limit);
      return response({ schema: SCHEMA, type: 'FeatureCollection', numberMatched: rows.length, numberReturned: features.length, features, bbox });
    }
    throw new Error(`Unexpected request: ${input}`);
  };
  w.fetch = async (input, init) => {
    requests.push({ url: new URL(input, w.location.href), init });
    return options.fetch ? options.fetch(input, init, defaultFetch, response) : defaultFetch(input, init);
  };
  let map;
  w.SurveyMap = class {
    constructor(id, callbacks) { map = this; this.callbacks = callbacks; this.data = []; this.selected = null; this.fits = []; this.zoom = 14; }
    setMeta(value) { this.meta = value; }
    setSessions(value) { this.sessions = value; }
    setData(...value) { this.data = value; }
    setLayers(value) { this.layers = value; }
    setTheme(value) { this.theme = value; }
    fitBBox(value) { this.fits.push(value); }
    select(value) { this.selected = value; }
    clearSelection() { this.selected = null; }
    getView() { return { lat: 12.93, lng: 77.565, zoom: this.zoom }; }
    setView() {}
    invalidateSize() {}
  };
  w.GIS_CONFIG = { apiBase: '' };
  const context = dom.getInternalVMContext();
  vm.runInContext(readFileSync(path.join(root, 'data.js'), 'utf8'), context);
  vm.runInContext(readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  await settle();
  return { w, map, requests, opened, errors, video, defaultFetch, response, dom, advance, imageRequests, imageNodes, dialogOpens };
}

function submit(app, values) {
  const form = app.w.document.getElementById('filterForm');
  for (const [key, value] of Object.entries(values)) {
    const inputs = [...form.querySelectorAll(`[name="${key}"]`)];
    for (const input of inputs) {
      if (input.type === 'checkbox') input.checked = Array.isArray(value) ? value.includes(input.value) : Boolean(value);
      else input.value = value;
    }
  }
  form.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
}

function text(app, id) { return app.w.document.getElementById(id).textContent; }

test('video-only boot defaults to metadata Potholes with only Video and Survey navigation', async t => {
  const app = await boot(t);
  assert.equal(text(app, 'surveyedStat'), '5 m');
  assert.match(text(app, 'segmentsStat'), /1 segments · 0 m not covered/);
  assert.equal(text(app, 'distressStat'), '100.0%');
  assert.equal(text(app, 'reviewStat'), '1');
  assert.equal(app.map.data[0].length, 1);
  assert.equal(app.map.data[1].length, 0);
  assert.deepEqual([...app.w.document.querySelectorAll('.nav-pill .nav-item .nav-label')].map(x=>x.textContent.trim()),['Video','Survey']);
  assert.equal(app.w.document.querySelector('[data-layer="citizen"], #citizenStat, #exportCitizen, [name="include_review"]'),null);
  assert.doesNotMatch(app.w.document.body.textContent,/citizen|walking|walk survey/i);
  assert.ok(app.requests.filter(r=>r.url.pathname.endsWith('segments.geojson')).every(r=>r.url.searchParams.get('label')==='Potholes'));
  assert.deepEqual(app.map.fits[0], bbox);
  assert.equal(app.w.document.querySelectorAll('[data-session]').length, 1);
  assert.equal(app.w.document.getElementById('notice').hidden, true);
  assert.deepEqual(app.errors, []);
});

test('video filters and CSV exports preserve supported parameters without a citizen query', async t => {
  const app = await boot(t);
  submit(app, { label: ['Potholes'], severity: ['High'], review: 'needs', status: 'send', date_from: '2026-10-27', date_to: '2026-10-27' });
  await settle();
  assert.match(text(app, 'segmentsStat'), /^1 segments/);
  const video = app.requests.filter(r => r.url.pathname === '/gis/video/segments.geojson').at(-1).url.searchParams;
  assert.equal(video.get('label'), 'Potholes');
  assert.equal(video.get('severity'), 'High');
  assert.equal(video.get('needs_review'), 'true');
  assert.equal(video.get('status'), 'send');
  assert.equal(video.get('date_from'), '2026-10-27T00:00:00+05:30');
  assert.equal(video.get('date_to'), '2026-10-28T00:00:00+05:30');
  app.w.document.getElementById('exportVideo').click();
  const exported = new URL(app.opened.at(-1)[0], app.w.location.href);
  assert.equal(exported.pathname, '/gis/video/segments.csv');
  assert.equal(exported.searchParams.get('label'), 'Potholes');
  assert.equal(exported.searchParams.has('geom'), false);
  assert.equal(exported.searchParams.get('needs_review'), 'true');
});

test('metadata confidence threshold filters Potholes and reset restores the Potholes default', async t => {
  const app = await boot(t);
  submit(app, { highConfidence: true });
  await settle();
  assert.match(text(app, 'segmentsStat'), /^0 segments/);
  assert.equal(app.requests.filter(r => r.url.pathname === '/gis/video/summary').at(-1).url.searchParams.get('min_confidence'), '0.8');
  assert.match(text(app, 'confidenceFilterLabel'), /80.0%/);
  app.w.document.getElementById('resetFilters').click();
  await settle();
  assert.match(text(app, 'segmentsStat'), /^1 segments/);
  assert.match(text(app,'activeFilters'),/Potholes/);
  assert.ok(app.w.document.querySelector('[name=label][value=Potholes]').checked);
});

for (const [index, expected] of [[2, 'Awaiting classification'], [3, 'Not sent to model'], [4, 'Not covered']]) {
  test(`${expected} is displayed without inventing a Normal diagnosis`, async t => {
    const app = await boot(t);
    submit(app,{label:[]});await settle();
    app.map.callbacks.onSelect(app.video[index]);
    const panel = app.w.document.getElementById('detailPanel');
    assert.equal(panel.querySelector('h2').textContent, expected);
    assert.match(panel.textContent, /No condition diagnosis is available/);
    assert.match(panel.textContent, /Not available/);
    if (index > 2) {
      assert.equal(panel.querySelector('img'), null);
      assert.equal(panel.querySelector('a[target="_blank"]'), null);
    } else {
      assert.ok(panel.querySelector('img'));
    }
  });
}

test('detail uses resized preview, shows uncertainty and recovers from an image failure', async t => {
  const app = await boot(t);
  app.map.callbacks.onSelect(app.video[0]);
  const image = app.w.document.getElementById('detailImage');
  assert.equal(new URL(image.src).searchParams.get('w'), '1280');
  const panel = app.w.document.getElementById('detailPanel');
  assert.match(panel.textContent, /±6 m/);
  assert.match(panel.textContent, /IST/);
  assert.match(panel.textContent, /awaiting expert review/);
  assert.equal(panel.querySelector('.confidence-threshold').style.left, '80%');
  assert.equal(panel.querySelector('.frame-full').getAttribute('href'), 'https://example.test/gis/image/drive-a_seg00000');
  image.dispatchEvent(new app.w.Event('error'));
  assert.match(text(app, 'detailFrame'), /Preview unavailable/);
  assert.equal(app.w.document.getElementById('detailFrame').querySelector('img'), null);
});

test('advanced detector evidence preserves zero scores, identifies absent scores, and separates counterfactual decisions',async t=>{
  const app=await boot(t,{video:[
    segment(0,{gate_probe_frac:0,gate_probe_max_logit:6.668,gate_evidence:0,gate_crack_mm:14305.7,gate_mode:'all',gate_decision_if_gated:'skip'}),
    segment(1,{gate_probe_frac:null,gate_probe_max_logit:null,gate_evidence:null,gate_crack_mm:null,gate_mode:'gate',gate_decision_if_gated:'skip'}),
  ]});
  const detectorValues=()=>Object.fromEntries([...app.w.document.querySelectorAll('.detail-advanced dt')].map(term=>[term.textContent,term.nextElementSibling.textContent]));
  app.map.callbacks.onSelect(app.video[0]);
  app.w.document.getElementById('expandDetail').click();
  app.w.document.querySelector('.detail-advanced summary').click();
  assert.equal(app.w.document.querySelector('.detail-advanced').open,true);
  let values=detectorValues();
  assert.equal(values['Probe fraction'],'0');
  assert.equal(values['Probe maximum logit'],'6.668');
  assert.equal(values['Gate evidence'],'0');
  assert.equal(values['Crack score (mm)'],'14305.7');
  assert.equal(values['Detector would have'],'skip');
  const gateStatus=[...app.w.document.querySelectorAll('.detail-grid dt')].find(term=>term.textContent==='Gate status');
  assert.equal(gateStatus.nextElementSibling.textContent,'send','counterfactual skip must not replace the actual send status');
  app.map.callbacks.onSelect(app.video[1]);values=detectorValues();
  for(const label of ['Probe fraction','Probe maximum logit','Gate evidence','Crack score (mm)'])assert.equal(values[label],'—',`${label} is absent, not zero`);
  assert.equal('Detector would have' in values,false,'counterfactual text only belongs to send-everything runs');
});

test('a late filter response cannot replace the more recent reset', async t => {
  let held = [];
  const app = await boot(t, { fakeClock:true, fetch: async (input, init, fallback) => {
    const url = new URL(input, 'https://example.test');
    if (url.searchParams.get('severity') === 'Low') return new Promise(resolve => held.push(async () => resolve(await fallback(input, init))));
    return fallback(input, init);
  } });
  submit(app, { severity: ['Low'] });
  await settle();
  assert.ok(held.length > 0);
  app.w.document.getElementById('surveyNav').click();
  app.w.document.getElementById('videoNav').click();
  app.advance(1000);
  app.w.document.getElementById('resetFilters').click();
  await settle();
  assert.match(text(app, 'segmentsStat'), /^1 segments/);
  await Promise.all(held.map(release => release()));
  await settle();
  assert.match(text(app, 'segmentsStat'), /^1 segments/);
  assert.equal(app.map.data[0].length, 1);
  assert.match(text(app,'activeFilters'),/Potholes/);
  assert.equal(app.w.document.getElementById('overviewDialog').open,false,'a late response must not reopen a dismissed Survey');
  assert.equal(app.w.document.querySelector('.nav-pill').dataset.active,'video');
});

test('API unavailability shows a retry state and retry restores observations', async t => {
  let failed = true;
  const app = await boot(t, { fetch: async (input, init, fallback) => failed
    ? { ok: false, status: 503, json: async () => ({ detail: 'Temporarily unavailable' }) }
    : fallback(input, init) });
  assert.equal(app.w.document.getElementById('notice').hidden, false);
  assert.match(text(app, 'noticeText'), /Survey data temporarily unavailable/);
  failed = false;
  app.w.document.getElementById('retryButton').click();
  await settle();
  assert.equal(text(app, 'surveyedStat'), '5 m');
  assert.equal(app.w.document.getElementById('notice').hidden, true);
});

test('a long drive strip stays virtualized and keyboard stepping keeps the map selection in sync', async t => {
  const app = await boot(t, { video: Array.from({ length: 528 }, (_, index) => segment(index)) });
  app.w.document.querySelector('[data-session="drive-a"]').click();
  app.w.document.getElementById('driveReplay').click();
  await settle();
  const viewport = app.w.document.getElementById('stripViewport');
  assert.equal(app.w.document.getElementById('stripPanel').hidden, false);
  assert.match(text(app, 'stripTitle'), /528 matching frames/);
  assert.ok(app.w.document.querySelectorAll('.frame-card').length < 12);
  assert.equal(app.map.selected.properties.k, 0);
  viewport.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(app.map.selected.properties.k, 1);
  assert.equal(text(app, 'stripPosition'), '2 / 528');
  viewport.scrollLeft = 40000;
  viewport.dispatchEvent(new app.w.Event('scroll'));
  assert.ok(app.w.document.querySelectorAll('.frame-card').length < 12);
  const visible = app.w.document.querySelector('.frame-card');
  visible.click();
  assert.ok(app.map.selected.properties.k > 200);
  assert.ok(app.w.document.querySelector('.frame-card[aria-selected="true"]'));
});

test('a closing observation and its failed preview cannot erase a newly selected observation', async t => {
  const app = await boot(t,{video:[segment(0),segment(1)],fakeClock:true});
  app.map.callbacks.onSelect(app.video[0]);
  const previous = app.w.document.getElementById('detailImage');
  assert.ok(previous.src);
  app.w.document.getElementById('closeDetail').click();
  assert.equal(app.map.selected,null,'closing immediately clears the selected map feature');
  assert.equal(app.w.document.getElementById('detailPanel').inert,true);
  app.map.callbacks.onSelect(app.video[1]);
  const current = app.w.document.getElementById('detailImage');
  assert.ok(current);
  assert.notEqual(previous, current);
  previous.dispatchEvent(new app.w.Event('error'));
  app.advance(1000);await settle();
  assert.equal(app.w.document.getElementById('detailImage'), current);
  assert.ok(app.w.document.querySelector('#detailFrame .frame-full'));
  assert.equal(app.w.document.getElementById('detailPanel').hidden,false);
  assert.equal(app.w.document.getElementById('detailPanel').inert,false);
  assert.equal(app.map.selected.properties.k,1,'a prior close timer cannot clear the new selection');
});

test('playback advances and pauses at 5 segments per second without loading original images', async t => {
  const app = await boot(t, { video: Array.from({ length: 30 }, (_, index) => segment(index)), fakeClock: true, autoImages: true });
  app.w.document.querySelector('[data-session="drive-a"]').click();
  app.w.document.getElementById('driveReplay').click();
  await settle();
  app.w.document.getElementById('speedSelect').value = '5';
  app.w.document.getElementById('playButton').click();
  assert.equal(app.w.document.getElementById('playButton').getAttribute('aria-label'), 'Pause route');
  app.advance(600);
  await settle();
  assert.equal(app.map.selected.properties.k, 3);
  assert.equal(text(app, 'stripPosition'), '4 / 30');
  app.w.document.getElementById('playButton').click();
  app.advance(600);
  assert.equal(app.map.selected.properties.k, 3);
  assert.equal(app.w.document.getElementById('playButton').getAttribute('aria-label'), 'Play along route');
  app.w.document.getElementById('playButton').click();
  const frameBeforeExpansion=app.w.document.getElementById('detailImage');
  app.w.document.getElementById('expandDetail').click();
  app.advance(1000);await settle();
  assert.equal(app.map.selected.properties.k,3,'opening full evidence pauses playback on the current frame');
  assert.equal(app.w.document.getElementById('playButton').getAttribute('aria-label'),'Play along route');
  assert.equal(app.w.document.getElementById('expandDetail').getAttribute('aria-label'),'Collapse observation details');
  assert.equal(app.w.document.getElementById('detailImage'),frameBeforeExpansion,'expansion preserves the currently loaded evidence');
  app.w.document.getElementById('expandDetail').click();
  assert.equal(app.w.document.getElementById('expandDetail').getAttribute('aria-label'),'Open observation details');
  assert.equal(app.map.selected.properties.k,3);
  assert.ok(app.imageRequests.some(url => new URL(url).searchParams.get('w') === '1280'));
  assert.ok(app.imageRequests.some(url => new URL(url).searchParams.get('w') === '480'));
  assert.ok(app.imageRequests.every(url => ['480', '1280'].includes(new URL(url).searchParams.get('w'))));
});

test('expert corrections take precedence in details and untrusted text is rendered literally', async t => {
  const feature = segment(0, { final_labels: ['Normal'], final_primary_label: 'Normal', vlm_class: 'normal',
    final_severity: 'None', severity: 'High', labels: ['Potholes'], expert_corrected_types: [], expert_corrected_severity: 'None',
    expert_reviewed: true, needs_expert_review: false, description: '<img src=x onerror="alert(1)">',
    camera_alt_ellipsoid_m: 875, camera_alt_msl_m: null });
  const app = await boot(t, { video: [feature] });
  submit(app,{label:[]});await settle();
  app.map.callbacks.onSelect(feature);
  const panel = app.w.document.getElementById('detailPanel');
  assert.equal(panel.querySelector('h2').textContent, 'Normal');
  assert.match(panel.textContent, /Expert-reviewed/);
  assert.match(panel.querySelector('s').textContent, /Potholes · High/);
  assert.equal(panel.querySelector('.description img'), null);
  assert.match(panel.querySelector('.description').textContent, /<img src=x/);
  assert.doesNotMatch(panel.textContent, /above mean sea level/);
});

test('exports and reports remain disabled while changed filters load or fail, then recover on reset', async t => {
  const held = [];
  const app = await boot(t, { fetch: async (input, init, fallback) => {
    const url = new URL(input, 'https://example.test');
    if (url.searchParams.get('severity') === 'Low') return new Promise(resolve => held.push(() => resolve({ ok: false, status: 503, json: async () => ({ detail: 'Unavailable' }) })));
    return fallback(input, init);
  } });
  const controls = ['exportVideo', 'insightsButton', 'printButton', 'mobileInsights'].map(id => app.w.document.getElementById(id));
  let prints = 0;
  app.w.print = () => prints++;
  assert.ok(controls.every(button => !button.disabled));
  submit(app, { severity: ['Low'] });
  await settle();
  assert.ok(held.length > 0);
  assert.ok(controls.every(button => button.disabled));
  controls.forEach(button => button.click());
  assert.equal(app.opened.length, 0);
  assert.equal(prints, 0);
  assert.equal(app.w.document.getElementById('insightsDialog').open, false);
  held.forEach(release => release());
  await settle();
  assert.match(text(app, 'noticeText'), /temporarily unavailable/);
  assert.ok(controls.every(button => button.disabled));
  controls.forEach(button => button.click());
  assert.equal(app.opened.length, 0);
  assert.equal(prints, 0);
  app.w.document.getElementById('resetFilters').click();
  await settle();
  assert.ok(controls.every(button => !button.disabled));
  app.w.document.getElementById('insightsButton').click();
  assert.equal(app.w.document.getElementById('insightsDialog').open, true);
});

test('crossing street zoom during a request reloads footprint geometry after that request completes', async t => {
  let hold = false;
  const held = [];
  const app = await boot(t, { fakeClock: true, fetch: async (input, init, fallback) => {
    const url = new URL(input, 'https://example.test');
    if (hold && url.searchParams.get('label') === 'Potholes') return new Promise(resolve => held.push(async () => resolve(await fallback(input, init))));
    return fallback(input, init);
  } });
  hold = true;
  submit(app, { label: ['Potholes'] });
  await settle();
  const geometryRequests = () => app.requests.filter(r => r.url.pathname === '/gis/video/segments.geojson');
  assert.equal(geometryRequests().at(-1).url.searchParams.get('geom'), 'point');
  const pendingCount = geometryRequests().length;
  app.map.zoom = 17;
  app.map.callbacks.onViewChange(app.map.getView());
  app.advance(200);
  assert.equal(geometryRequests().length, pendingCount);
  hold = false;
  await Promise.all(held.map(release => release()));
  await settle();
  app.advance(0);
  await settle();
  assert.equal(geometryRequests().length, pendingCount + 1);
  assert.equal(geometryRequests().at(-1).url.searchParams.get('geom'), 'footprint');
  assert.equal(geometryRequests().at(-1).url.searchParams.get('label'), 'Potholes');
  assert.equal(app.w.document.getElementById('notice').hidden, true);
});

test('playback reuses visible strip nodes and thumbnails until the visible frame range changes', async t => {
  const app = await boot(t, { video: Array.from({ length: 30 }, (_, index) => segment(index)), fakeClock: true, autoImages: true });
  app.w.document.querySelector('[data-session="drive-a"]').click();
  app.w.document.getElementById('driveReplay').click();
  await settle();
  const nodes = [...app.w.document.querySelectorAll('.frame-card')];
  const thumbnails = () => app.imageRequests.filter(url => new URL(url).searchParams.get('w') === '480').length;
  const initialThumbnails = thumbnails();
  assert.ok(nodes.length > 1);
  app.w.document.getElementById('speedSelect').value = '5';
  app.w.document.getElementById('playButton').click();
  app.advance(600);
  await settle();
  assert.equal(app.map.selected.properties.k, 3);
  const after = [...app.w.document.querySelectorAll('.frame-card')];
  assert.equal(after.length, nodes.length);
  after.forEach((node, index) => assert.equal(node, nodes[index]));
  assert.equal(thumbnails(), initialThumbnails);
  assert.match(app.w.document.querySelector('.frame-card[aria-selected="true"]').getAttribute('aria-label'), /^Segment 4,/);
  app.w.document.getElementById('playButton').click();
});

function twoDrives(){
  const first=Array.from({length:4},(_,i)=>segment(i));
  const second=Array.from({length:3},(_,i)=>{const f=segment(i,{session_id:'drive-b',road_name:'Second road'});f.id=f.properties.segment_id='drive-b_seg'+String(i).padStart(5,'0');return f;});
  return {video:[...first,...second],sessions:[session(first),{...session(second),session_id:'drive-b',road_name:'Second road',bbox:[77.57,12.93,77.58,12.94]}]};
}
function selectDrive(app,id){const el=app.w.document.getElementById('driveSelect');el.value=id;el.dispatchEvent(new app.w.Event('change',{bubbles:true}));}
function layer(app,key,checked){const el=app.w.document.querySelector(`[data-layer="${key}"]`);el.checked=checked;el.dispatchEvent(new app.w.Event('change',{bubbles:true}));}

test('drive inspection and opt-in replay preserve every route and global total without issuing new filters',async t=>{
  const app=await boot(t,twoDrives());
  const requests=app.requests.length,total=text(app,'totalDistance');
  assert.equal(app.imageRequests.length,0,'boot must not download any road photos');
  assert.equal(text(app,'mapScope'),'All drive surveys');
  app.w.document.getElementById('driveReplay').click();await settle();
  assert.equal(app.map.selected.properties.session_id,'drive-a');
  assert.equal(text(app,'mapScope'),'Test road · 2026-10-27','direct default replay must name the drive being played');
  assert.equal(app.w.document.querySelector('[data-session="drive-a"]').getAttribute('aria-pressed'),'true','direct replay also identifies the active drive in Survey');
  app.w.document.getElementById('closeStrip').click();
  selectDrive(app,'drive-b');await settle();
  assert.equal(text(app,'mapScope'),'Second road · 2026-10-27','inspection updates the map caption without filtering other drives');
  assert.equal(app.w.document.querySelector('[data-session="drive-b"]').getAttribute('aria-pressed'),'true');
  assert.equal(app.requests.length,requests);
  assert.equal(app.map.sessions.length,2);
  assert.equal(app.map.data[0].length,7);
  assert.equal(text(app,'totalDistance'),total);
  assert.match(text(app,'driveDetails'),/3 segments/);
  assert.equal(app.w.document.getElementById('stripPanel').hidden,true);
  assert.equal(app.map.selected,null);
  app.w.document.getElementById('driveReplay').click();await settle();
  assert.equal(app.map.selected.properties.session_id,'drive-b');
  assert.equal(text(app,'mapScope'),'Second road · 2026-10-27','replay keeps the inspected-drive caption');
  assert.equal(text(app,'stripPosition'),'1 / 3');
  assert.equal(app.map.sessions.length,2);
  assert.equal(app.map.data[0].length,7);
  assert.equal(app.requests.length,requests);
  assert.equal(text(app,'totalDistance'),total);
  app.w.document.getElementById('insightsButton').click();
  const report=text(app,'insightsBody');
  assert.match(report,/Second road/);
  assert.doesNotMatch(report,/Test road/,'selected-drive report must not include the unselected drive profile');
  assert.match(report,/Current filter/,'global filter summary remains distinctly labelled');
});

test('explicit drive filter narrows observations while keeping all routes and reset restores Potholes',async t=>{
  const app=await boot(t,twoDrives());
  submit(app,{session:'drive-b'});await settle();
  assert.equal(app.map.data[0].length,3);
  assert.match(text(app,'activeFilters'),/Second road/,'the applied drive scope must be visible outside the closed filter dialog');
  assert.ok(app.map.data[0].every(f=>f.properties.session_id==='drive-b'));
  assert.equal(app.map.sessions.length,2);
  assert.equal(app.requests.filter(r=>r.url.pathname==='/gis/video/segments.geojson').at(-1).url.searchParams.get('session'),'drive-b');
  app.w.document.getElementById('resetFilters').click();await settle();
  assert.equal(app.map.data[0].length,7);
  assert.equal(app.w.document.getElementById('sessionFilter').value,'');
  assert.match(text(app,'activeFilters'),/Potholes/);
});

test('Survey opens the dashboard and pauses playback while Video returns to the map without losing routes',async t=>{
  const app=await boot(t,{video:Array.from({length:30},(_,i)=>segment(i)),fakeClock:true,autoImages:true});
  app.w.document.getElementById('driveReplay').click();await settle();
  app.w.document.getElementById('playButton').click();app.advance(500);await settle();
  const frame=app.map.selected.properties.k;
  app.w.document.getElementById('surveyNav').click();
  assert.equal(app.w.document.getElementById('overviewDialog').open,true);
  app.advance(1000);await settle();assert.equal(app.map.selected.properties.k,frame);
  app.w.document.getElementById('videoNav').click();app.advance(1000);await settle();
  assert.equal(app.w.document.getElementById('overviewDialog').open,false);
  assert.equal(app.map.sessions.length,1);
  assert.equal(app.map.data[0].length,30);
  assert.equal(app.w.document.getElementById('playButton').getAttribute('aria-label'),'Play along route');
});

test('narrowing a complete cached result updates map immediately but keeps exports disabled until authoritative stats',async t=>{
  let held=[];
  const app=await boot(t,{video:[segment(0),segment(1,{final_severity:'Low'})],fetch:async(input,init,fallback)=>{
    const u=new URL(input,'https://example.test');
    if(u.searchParams.get('severity')==='High')return new Promise(resolve=>held.push(async()=>resolve(await fallback(input,init))));
    return fallback(input,init);
  }});
  submit(app,{severity:['High']});
  assert.equal(app.map.data[0].length,1,'complete loaded rows narrow synchronously');
  assert.equal(app.w.document.getElementById('exportVideo').disabled,true);
  await settle();await Promise.all(held.map(f=>f()));await settle();
  assert.match(text(app,'segmentsStat'),/^1 segments/);
  assert.equal(app.w.document.getElementById('exportVideo').disabled,false);
});

test('temporary API failure retries at 30 seconds and recovers without a manual click',async t=>{
  let failed=true;
  const app=await boot(t,{fakeClock:true,fetch:async(input,init,fallback)=>failed?{ok:false,status:503,json:async()=>({detail:'Unavailable'})}:fallback(input,init)});
  const calls=app.requests.length;app.advance(29999);await settle();assert.equal(app.requests.length,calls);
  failed=false;app.advance(1);await settle();
  assert.equal(text(app,'surveyedStat'),'5 m');
  assert.equal(app.w.document.getElementById('notice').hidden,true);
});

test('image queue caps outstanding requests at six while selection changes quickly',async t=>{
  const app=await boot(t,{video:Array.from({length:528},(_,i)=>segment(i))});
  app.w.document.getElementById('driveReplay').click();await settle();
  assert.equal(app.imageRequests.length,6);
  for(let i=10;i<40;i++)app.map.callbacks.onSelect(app.video[i]);
  assert.equal(app.imageRequests.length,6,'uncompleted requests retain their six available slots');
  const firstSix=app.imageNodes.slice();
  firstSix.forEach(img=>img.dispatchEvent(new app.w.Event('load')));await settle();
  assert.ok(app.imageRequests.length<=12,'only six further requests may begin after six complete');
  assert.ok(app.imageRequests.every(url=>['480','1280'].includes(new URL(url).searchParams.get('w'))));
});

test('catalogues above 5000 segments scope the first drive before loading while retaining every route',async t=>{
  const a=Array.from({length:3000},(_,i)=>segment(i));
  const b=Array.from({length:3000},(_,i)=>{const f=segment(i,{session_id:'drive-b'});f.id=f.properties.segment_id='drive-b_'+i;return f;});
  const app=await boot(t,{video:[...a,...b],sessions:[session(a),{...session(b),session_id:'drive-b'}]});
  const requests=app.requests.filter(r=>r.url.pathname==='/gis/video/segments.geojson');
  assert.equal(requests.length,3,'three pages of selected drive loaded');
  assert.ok(requests.every(r=>r.url.searchParams.get('session')==='drive-a'));
  assert.equal(app.map.data[0].length,3000);
  assert.equal(app.map.sessions.length,2);
  assert.equal(app.w.document.getElementById('sessionFilter').value,'drive-a');
  assert.equal(app.imageRequests.length,0);
});

test('a failed replay fetch for an unloaded drive cannot select stale segments from another drive',async t=>{
  const a=Array.from({length:3000},(_,i)=>segment(i));
  const b=Array.from({length:3000},(_,i)=>{const f=segment(i,{session_id:'drive-b'});f.id=f.properties.segment_id='drive-b_'+i;return f;});
  let failB=true;
  const app=await boot(t,{video:[...a,...b],sessions:[session(a),{...session(b),session_id:'drive-b'}],fetch:async(input,init,fallback)=>{
    const u=new URL(input,'https://example.test');
    if(failB&&u.searchParams.get('session')==='drive-b')return{ok:false,status:503,json:async()=>({detail:'Unavailable'})};
    return fallback(input,init);
  }});
  selectDrive(app,'drive-b');app.w.document.getElementById('driveReplay').click();await settle();
  assert.equal(app.map.selected,null);
  assert.match(text(app,'noticeText'),/temporarily unavailable/);
  assert.equal(app.w.document.getElementById('exportVideo').disabled,true);
  assert.equal(app.w.document.getElementById('detailPanel').hidden,true);
  failB=false;app.w.document.getElementById('retryButton').click();await settle();
  app.w.document.getElementById('driveReplay').click();await settle();
  assert.equal(app.map.selected.properties.session_id,'drive-b');
});

test('empty shared filters display zero matches and no-result report without automatic image requests',async t=>{
  const app=await boot(t);
  submit(app,{review:'reviewed'});await settle();
  assert.match(text(app,'segmentsStat'),/^0 segments/);
  assert.equal(app.w.document.getElementById('mapEmpty').hidden,false);
  assert.equal(app.map.data[0].length,0);
  assert.equal(app.imageRequests.length,0);
  app.w.document.getElementById('clearEmpty').click();await settle();
  assert.equal(app.map.data[0].length,1);
});

test('an open route player cannot reselect old unmatched frames while filters load or remain unavailable',async t=>{
  const held=[];
  const app=await boot(t,{fakeClock:true,autoImages:true,fetch:async(input,init,fallback)=>{
    const u=new URL(input,'https://example.test');
    if(u.searchParams.get('reviewed')==='true')return new Promise(resolve=>held.push(()=>resolve({ok:false,status:503,json:async()=>({detail:'Unavailable'})})));
    return fallback(input,init);
  }});
  app.w.document.getElementById('driveReplay').click();await settle();
  assert.ok(app.map.selected);
  submit(app,{review:'reviewed'});await settle();
  assert.equal(app.map.data[0].length,0,'cached map correctly previews empty reviewed results');
  assert.equal(app.map.selected,null);
  const tryOldSelection=()=>{
    app.w.document.getElementById('playButton').click();app.advance(600);
    app.w.document.getElementById('nextButton').click();
    app.w.document.getElementById('stripViewport').dispatchEvent(new app.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    app.w.document.querySelector('.frame-card')?.click();
  };
  tryOldSelection();assert.equal(app.map.selected,null,'old frames must stay unselectable while new results load');
  held.forEach(release=>release());await settle();
  assert.match(text(app,'noticeText'),/temporarily unavailable/);
  tryOldSelection();assert.equal(app.map.selected,null,'failed refresh must not revive old frames under new filters');
});

test('Potholes default and reset use the exact canonical name supplied by metadata',async t=>{
  const canonical='POTHOLES';
  const feature=segment(0,{final_labels:[canonical],final_primary_label:canonical,marker_label:canonical});
  const app=await boot(t,{video:[feature],meta:{labels:meta.labels.map(l=>l.name==='Potholes'?{...l,name:canonical}:l)}});
  const queries=()=>app.requests.filter(r=>r.url.pathname==='/gis/video/segments.geojson');
  assert.equal(queries().at(-1).url.searchParams.get('label'),canonical);
  assert.equal(app.w.document.querySelector('[name=label]:checked').value,canonical);
  submit(app,{label:[]});await settle();
  assert.equal(queries().at(-1).url.searchParams.has('label'),false);
  app.w.document.getElementById('resetFilters').click();await settle();
  assert.equal(queries().at(-1).url.searchParams.get('label'),canonical);
  assert.equal(app.w.document.querySelector('[name=label]:checked').value,canonical);
});

test('a shared all-label choice stays explicit and legacy citizen URL flags cannot revive that layer',async t=>{
  const app=await boot(t,{url:'https://example.test/gis/app/#label=&include_review=true'});
  assert.equal(app.map.data[0].length,5);
  assert.ok(app.requests.filter(r=>r.url.pathname==='/gis/video/segments.geojson').every(r=>!r.url.searchParams.has('label')));
  assert.equal(new app.w.URLSearchParams(app.w.location.hash.slice(1)).has('label'),true);
  assert.equal(app.w.document.querySelector('[data-layer=citizen]'),null);
  app.w.document.getElementById('resetFilters').click();await settle();
  assert.equal(app.map.data[0].length,1);
  assert.equal(app.requests.filter(r=>r.url.pathname==='/gis/video/segments.geojson').at(-1).url.searchParams.get('label'),'Potholes');
});

test('real sample default dashboard shows exactly 131 drive Potholes with metadata and all three routes',async t=>{
  const sample=path.resolve(__dirname,'../gis_sample/api/gis');
  const read=p=>JSON.parse(readFileSync(path.join(sample,p),'utf8'));
  const video=read('video/segments_point.geojson').features,realMeta=read('meta.json'),sessions=read('video/sessions.json').sessions;
  const app=await boot(t,{video,meta:realMeta,sessions});
  assert.equal(app.map.data[0].length,131);
  assert.ok(app.map.data[0].every(f=>f.properties.final_labels.includes('Potholes')));
  assert.equal(app.map.data[1].length,0);
  assert.equal(app.map.sessions.length,3);
  assert.match(text(app,'segmentsStat'),/^131 segments/);
  assert.equal(text(app,'surveyedStat'),'652.3 m');
  assert.equal(text(app,'reviewStat'),'111');
  assert.match(text(app,'totalDistance'),/4.06 km/);
  assert.equal(app.w.document.querySelectorAll('#driveSelect option').length,4);
});

function clickOutside(app){const target=app.w.document.getElementById('surveyMap');target.dispatchEvent(new app.w.MouseEvent('pointerdown',{bubbles:true}));target.click();}
function escape(app){app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));}

test('Survey is a nonmodal anchored surface with synchronized navigation and focus-return dismissal',async t=>{
  const app=await boot(t,{fakeClock:true});
  const doc=app.w.document,survey=doc.getElementById('surveyNav'),video=doc.getElementById('videoNav'),panel=doc.getElementById('overviewDialog');
  app.map.callbacks.onSelect(app.video[0]);
  survey.focus();survey.click();app.advance(32);
  assert.equal(panel.open,true);
  assert.equal(app.dialogOpens.filter(x=>x.id==='overviewDialog').at(-1).modal,false);
  assert.equal(survey.getAttribute('aria-pressed'),'true');
  assert.equal(survey.getAttribute('aria-expanded'),'true');
  assert.equal(video.getAttribute('aria-pressed'),'false');
  assert.equal(doc.querySelector('.nav-pill').dataset.active,'survey');
  assert.ok(panel.contains(doc.activeElement),'opening moves focus into Survey');
  escape(app);app.advance(1000);await settle();
  assert.equal(panel.open,false);
  assert.equal(survey.getAttribute('aria-expanded'),'false');
  assert.equal(video.getAttribute('aria-pressed'),'true');
  assert.equal(doc.activeElement,survey);
  assert.equal(app.map.selected,app.video[0],'dismissing Survey preserves the inspected observation');
  assert.equal(doc.getElementById('detailPanel').hidden,false);
  survey.click();app.advance(32);clickOutside(app);app.advance(1000);await settle();
  assert.equal(panel.open,false);
  assert.equal(doc.querySelector('.nav-pill').dataset.active,'video');
});

test('toolbar surfaces exclude each other, keep internal interactions open, and dismiss outside or with Escape',async t=>{
  const app=await boot(t,{fakeClock:true});const doc=app.w.document;
  const survey=doc.getElementById('surveyNav'),overview=doc.getElementById('overviewDialog');
  const settings=doc.querySelector('.layers-control'),settingsButton=settings.querySelector('summary');
  const exports=doc.querySelector('.export-menu'),exportButton=exports.querySelector('summary');
  const filter=doc.getElementById('filterButton'),filterPanel=doc.getElementById('filterDialog');
  const drives=doc.getElementById('drivePanel'),driveButton=doc.getElementById('driveToggle');
  const legend=doc.getElementById('legendControl'),legendButton=doc.getElementById('legendButton');
  assert.equal(drives.hidden,true,'the Drives menu starts collapsed');
  assert.equal(driveButton.getAttribute('aria-expanded'),'false');
  survey.focus();survey.click();app.advance(32);
  settingsButton.focus();settingsButton.click();app.advance(1000);await settle();
  assert.equal(overview.open,false);
  assert.equal(settings.open,true);
  assert.equal(settingsButton.getAttribute('aria-expanded'),'true');
  const track=doc.querySelector('[data-layer=track]');track.click();app.advance(32);await settle();
  assert.equal(settings.open,true,'changing a layer inside Settings must not dismiss it');
  exportButton.focus();exportButton.click();app.advance(1000);await settle();
  assert.equal(settings.open,false);
  assert.equal(exports.open,true);
  filter.focus();filter.click();app.advance(1000);await settle();
  assert.equal(exports.open,false);
  assert.equal(filterPanel.open,true);
  assert.equal(filter.getAttribute('aria-expanded'),'true');
  escape(app);app.advance(1000);await settle();
  assert.equal(filterPanel.open,false);
  assert.equal(filter.getAttribute('aria-expanded'),'false');
  assert.equal(doc.activeElement,filter);
  exportButton.focus();exportButton.click();app.advance(32);clickOutside(app);app.advance(1000);await settle();
  assert.equal(exports.open,false);
  assert.equal(exportButton.getAttribute('aria-expanded'),'false');
  driveButton.focus();driveButton.click();app.advance(32);
  assert.equal(drives.hidden,false);
  assert.equal(driveButton.getAttribute('aria-expanded'),'true');
  legendButton.focus();legendButton.click();app.advance(1000);await settle();
  assert.equal(drives.hidden,true);
  assert.equal(driveButton.getAttribute('aria-expanded'),'false');
  assert.equal(legend.open,true);
  assert.equal(legendButton.getAttribute('aria-expanded'),'true');
  escape(app);app.advance(1000);await settle();
  assert.equal(legend.open,false);
  assert.equal(doc.activeElement,legendButton);
});

test('reopening Survey during its close motion cancels stale closure and cannot steal focus back',async t=>{
  const app=await boot(t,{fakeClock:true});const doc=app.w.document;
  const button=doc.getElementById('surveyNav'),panel=doc.getElementById('overviewDialog');
  button.focus();button.click();app.advance(32);
  escape(app);
  button.click();app.advance(1000);await settle();
  assert.equal(panel.open,true,'late close completion must not remove a reopened Survey');
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.ok(panel.contains(doc.activeElement),'stale close must not return focus to the trigger');
  doc.querySelector('[data-close=overviewDialog]').click();app.advance(1000);await settle();
  assert.equal(panel.open,false);
  assert.equal(doc.activeElement,button);
});

test('modal report dismissal restores Survey focus after native close for the close button and Escape',async t=>{
  const app=await boot(t,{fakeClock:true});const doc=app.w.document;
  const survey=doc.getElementById('surveyNav'),report=doc.getElementById('insightsDialog');
  for(const dismissal of ['button','native-cancel']){
    survey.focus();survey.click();app.advance(32);
    doc.getElementById('insightsButton').click();app.advance(1000);await settle();
    assert.equal(report.open,true);
    assert.equal(app.dialogOpens.filter(x=>x.id==='insightsDialog').at(-1).modal,true);
    assert.ok(report.contains(doc.activeElement));
    assert.equal(doc.querySelector('.nav-pill').dataset.active,'survey');
    survey.focus();
    assert.ok(report.contains(doc.activeElement),'the modal must block focus moving to the page behind it');
    if(dismissal==='button')doc.querySelector('[data-close=insightsDialog]').click();
    else{const cancel=new app.w.Event('cancel',{cancelable:true});report.dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);}
    assert.equal(report.open,true,'native modal stays open until its exit motion completes');
    assert.notEqual(doc.activeElement,survey,'background focus cannot be restored while the modal is open');
    app.advance(1000);await settle();
    assert.equal(report.open,false);
    assert.equal(doc.activeElement,survey,'dismissal returns keyboard focus to the visible Survey control');
    assert.equal(doc.querySelector('.nav-pill').dataset.active,'video');
  }
});

test('reopening a closing modal report keeps focus inside and cancels the old focus return',async t=>{
  const app=await boot(t,{fakeClock:true});const doc=app.w.document;
  const report=doc.getElementById('insightsDialog'),survey=doc.getElementById('surveyNav');
  doc.getElementById('insightsButton').click();app.advance(32);
  doc.querySelector('[data-close=insightsDialog]').click();
  doc.getElementById('insightsButton').click();app.advance(1000);await settle();
  assert.equal(report.open,true);
  assert.ok(report.contains(doc.activeElement),'the old exit completion cannot return focus behind the reopened report');
  assert.equal(doc.querySelector('.nav-pill').dataset.active,'survey');
  doc.querySelector('[data-close=insightsDialog]').click();app.advance(1000);await settle();
  assert.equal(report.open,false);
  assert.equal(doc.activeElement,survey,'a later completed dismissal still restores focus');
});

test('reduced motion completes Survey and toolbar dismissal without waiting for animation timers',async t=>{
  const app=await boot(t,{fakeClock:true,reducedMotion:true});const doc=app.w.document;
  const button=doc.getElementById('surveyNav'),panel=doc.getElementById('overviewDialog');
  button.focus();button.click();await settle();assert.equal(panel.open,true);
  escape(app);await settle();
  assert.equal(panel.open,false);
  assert.equal(doc.activeElement,button);
  const exportMenu=doc.querySelector('.export-menu'),exportButton=exportMenu.querySelector('summary');
  exportButton.focus();exportButton.click();await settle();assert.equal(exportMenu.open,true);
  escape(app);await settle();assert.equal(exportMenu.open,false);
  assert.equal(doc.activeElement,exportButton);
  app.map.callbacks.onSelect(app.video[0]);
  doc.getElementById('closeDetail').click();await settle();
  assert.equal(doc.getElementById('detailPanel').hidden,true,'reduced-motion observation close is immediate');
  assert.equal(app.map.selected,null);
  doc.getElementById('insightsButton').click();await settle();
  assert.equal(doc.getElementById('insightsDialog').open,true);
  doc.querySelector('[data-close=insightsDialog]').click();await settle();
  assert.equal(doc.getElementById('insightsDialog').open,false,'reduced-motion modal close is immediate');
  assert.equal(doc.activeElement,button,'modal focus returns after native close even without an animation delay');
});
