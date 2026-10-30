const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../webgis/data.js');

test('shared filters use API vocabulary and isolate video/citizen parameters', () => {
  const filters = { label: ['Potholes', 'Alligator Cracking'], severity: ['Medium', 'High'],
    review: 'needs', highConfidence: true, threshold: 0.87, vlm_class: 'distress',
    status: 'send,audit', session: 'drive-1', include_review: true };
  const video = Object.fromEntries(data.params(filters, 'video', { geom: 'point', include_review: true, nonsense: 1 }));
  assert.deepEqual(video, { label: 'Potholes,Alligator Cracking', severity: 'Medium,High',
    vlm_class: 'distress', needs_review: 'true', min_confidence: '0.87', session: 'drive-1', status: 'send,audit', geom: 'point' });
  const citizen = Object.fromEntries(data.params(filters, 'citizen', { geom: 'point', answered: true, session: 'bad' }));
  assert.deepEqual(citizen, { label: 'Potholes,Alligator Cracking', severity: 'Medium,High',
    vlm_class: 'distress', needs_review: 'true', min_confidence: '0.87', include_review: 'true' });
  assert.equal(data.params({ review: 'reviewed' }).get('reviewed'), 'true');
  assert.equal(data.params({ review: 'all', label: [], severity: [] }).toString(), '');
  assert.throws(() => data.params({ highConfidence: true }), /threshold/);
});

test('UI dates cover inclusive IST calendar days without depending on the host timezone', () => {
  const query = data.params({ date_from: '2026-10-26', date_to: '2026-10-27' });
  assert.equal(query.get('date_from'), '2026-10-26T00:00:00+05:30');
  assert.equal(query.get('date_to'), '2026-10-28T00:00:00+05:30');
  assert.equal(new Date(query.get('date_from')).toISOString(), '2026-10-25T18:30:00.000Z');
  assert.equal(data.params({ date_to: '2024-02-29' }).get('date_to'), '2024-03-01T00:00:00+05:30');
  assert.equal(data.params({ date_to: '2026-12-31' }).get('date_to'), '2027-01-01T00:00:00+05:30');
  assert.throws(() => data.params({ date_from: '2026-02-30' }), /valid calendar/);
  assert.throws(() => data.params({ date_from: '2026-10-28', date_to: '2026-10-27' }), /Start date/);
  assert.match(data.localTime('2026-10-26T11:44:08Z'), /17:14:08 IST$/);
  assert.equal(data.localTime(null), 'Time unavailable');
});

test('metadata controls colour/radius and missing coverage never inherits a normal label', () => {
  const meta = { labels: [{ name: 'Potholes', color: '#123456' }], other_label_color: '#abcdef',
    vlm_classes: [{ name: 'normal', color: '#223344' }, { name: 'not_covered', color: '#112233' }],
    severities: [{ name: 'None', radius_px: 3 }, { name: 'High', radius_px: 17 }, { name: 'Unknown', radius_px: 5 }] };
  assert.equal(data.color({ vlm_class: 'distress', marker_label: 'Potholes' }, meta), '#123456');
  assert.equal(data.color({ vlm_class: 'not_covered', marker_label: 'Normal' }, meta), '#112233');
  assert.equal(data.color({ vlm_class: 'unknown' }, meta), '#abcdef');
  assert.equal(data.radius({ final_severity: 'High' }, meta), 17);
  assert.equal(data.radius({ final_severity: 'None', vlm_class: 'distress' }, meta), 3);
  assert.equal(data.radius({}, meta), 5);
  assert.equal(data.featureId({ id: 0, properties: { id: 'wrong' } }), '0');
  assert.equal(data.featureId({ properties: { segment_id: 'segment-1' } }), 'segment-1');
});

test('CSV preserves Unicode and quotes while neutralizing spreadsheet formulas', () => {
  const csv = data.citizenCSV([{ properties: { id: 'abc', photo_id: 7, final_labels: ['Potholes', 'Bleeding'],
    description: '=HYPERLINK("bad")', address: '  @evil,\n§ road', latitude: -12.3, expert_reviewed: false } }]);
  assert.ok(csv.startsWith('\uFEFFid,photo_id'));
  assert.ok(csv.includes('Potholes; Bleeding'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"\'  @evil,\n§ road"'));
  assert.ok(csv.includes(',-12.3,'));
  assert.ok(csv.includes(',false,'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!data.citizenCSV([]).includes('undefined'));
});

test('coverage sums exclusive metres, keeps gaps distinct, and never sums overlapping labels', () => {
  const coverage = data.perKmCoverage({ surveyed_m: 1000, not_covered_m: 25, classified_m: 900,
    distress_m: 100, normal_m: 800, pending_m: 50, not_sent_m: 25, labels_m: { A: 80, B: 80 } });
  assert.equal(coverage.reduce((sum, c) => sum + c.metres, 0), 1025);
  assert.equal(coverage.find(c => c.name === 'distress').metres, 100);
  assert.equal(coverage.find(c => c.name === 'unknown').metres, 25);
  assert.equal(coverage.find(c => c.name === 'not_covered').metres, 25);
  assert.ok(Math.abs(coverage.reduce((sum, c) => sum + c.fraction, 0) - 1) < 1e-12);
  const missing = data.perKmCoverage({ surveyed_m: 100 });
  assert.equal(missing.find(c => c.name === 'normal').metres, 0);
  assert.equal(missing.find(c => c.name === 'unknown').metres, 100);
  assert.equal(data.perKmCoverage({}).reduce((sum, c) => sum + c.fraction, 0), 0);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function feature(id) { return { type: 'Feature', id, geometry: null, properties: {} }; }

test('paging loads every requested page without mutating filters and reports caps', async t => {
  const calls = [];
  const all = Array.from({ length: 7 }, (_, i) => feature(String(i)));
  t.mock.method(globalThis, 'fetch', async url => {
    const q = new URL(url).searchParams; calls.push(q);
    const offset = +q.get('offset'), limit = +q.get('limit');
    return response({ schema: 'geoai.gis.v1', numberMatched: all.length, features: all.slice(offset, offset + limit) });
  });
  const filters = new URLSearchParams({ label: 'Potholes' });
  const full = await data.fetchPages('https://example.test/gis/video/segments.geojson', filters, { pageSize: 3, maxFeatures: 10 });
  assert.equal(full.features.length, 7); assert.equal(full.total, 7); assert.equal(full.truncated, false);
  assert.deepEqual(calls.map(q => q.get('offset')), ['0', '3', '6']);
  assert.equal(filters.toString(), 'label=Potholes');
  const capped = await data.fetchPages('https://example.test/gis/video/segments.geojson', filters, { pageSize: 3, maxFeatures: 4 });
  assert.equal(capped.features.length, 4); assert.equal(capped.truncated, true);
});

test('paging propagates API errors, rejects incomplete pages, and honors abort', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => response({ detail: 'maintenance' }, 503));
  await assert.rejects(data.fetchJSON('/gis/meta'), error => error.status === 503 && /temporarily unavailable/.test(error.message));
  mocked.mock.mockImplementation(async () => response({ schema: 'geoai.gis.v1', numberMatched: 3, features: [] }));
  await assert.rejects(data.fetchPages('/gis/video/segments.geojson'), /incomplete page/);
  mocked.mock.mockImplementation(async () => response({ schema: 'wrong' }));
  await assert.rejects(data.fetchJSON('/gis/meta'), /Unsupported survey data format/);
  const abort = new DOMException('Cancelled', 'AbortError');
  mocked.mock.mockImplementation(async () => { throw abort; });
  await assert.rejects(data.fetchJSON('/gis/meta'), error => error === abort);
});

test('pagination detects duplicate IDs instead of silently presenting corrupt counts', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ schema: 'geoai.gis.v1', numberMatched: 4,
    features: [feature('same'), feature('other')] }));
  await assert.rejects(data.fetchPages('/gis/video/segments.geojson', {}, { pageSize: 2 }), /changed during loading/);
});
