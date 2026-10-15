import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, classify, detectDateOrder, filterBu, isSandbox, kindOf, parseCsv, parseTime, readExport, summarize, withThreshold, type Dataset } from './core.ts';

const HEADER = 'Journey Name, Version, Journey ID, User Name, User ID, Action, Time';
const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const V3 = '33333333-3333-3333-3333-333333333333';
const S1 = '99999999-9999-9999-9999-999999999999';
const row = (name: string, ver: number, id: string, user: string, uid: string, action: string, time: string) =>
  `${name}, ${ver}, ${id}, ${user}, ${uid}, ${action}, ${time}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const ok = (r: ReturnType<typeof build>): Dataset => { if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`); return r.data; };
const versions = (d: Dataset) => d.journeys.flatMap(j => j.versions);

// A small but complete scenario (MM/DD, day 13 makes the order unambiguous):
//   v1 of Promo_1026: created, edited 3x over 30 min, tested, published        → tested
//   v2 of Promo_1026: created and published within 1 min, 1 Modify, no test    → quick_copy
//   v1 of Welcome:    created, edited, published after 40 min, no test         → edited
const SCENARIO = csv(
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Create', '10/13/2026 09:00:00 AM'),
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Modify', '10/13/2026 09:10:00 AM'),
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Modify', '10/13/2026 09:20:00 AM'),
  row(`SIMULATION1 journeyId ${V1}`, 1, S1, 'Anna', 'u1', 'Create', '10/13/2026 09:25:00 AM'),
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Modify', '10/13/2026 09:28:00 AM'),
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Publish', '10/13/2026 09:30:00 AM'),
  row('Promo_1026', 1, V1, 'Anna', 'u1', 'Publish', '10/13/2026 09:30:20 AM'),
  row('Promo_1026', 2, V2, 'Boris', 'u2', 'Create', '10/14/2026 12:00:00 PM'),
  row('Promo_1026', 2, V2, 'Boris', 'u2', 'Modify', '10/14/2026 12:00:20 PM'),
  row('Promo_1026', 2, V2, 'Boris', 'u2', 'Publish', '10/14/2026 12:00:40 PM'),
  row('Promo_1026', 1, V1, 'Boris', 'u2', 'Unpublish', '10/14/2026 12:00:45 PM'),
  row('Welcome, new clients', 1, V3, 'Anna', 'u1', 'Create', '10/15/2026 12:30:00 AM'),
  row('Welcome, new clients', 1, V3, 'Anna', 'u1', 'Modify', '10/15/2026 12:50:00 AM'),
  row('Welcome, new clients', 1, V3, 'Anna', 'u1', 'Publish', '10/15/2026 01:10:00 AM'),
);

test('parseCsv: quotes, escaped quotes, commas, CRLF, BOM and blank lines', () => {
  const rows = parseCsv('﻿a, "b, c", "say ""hi"""\r\n\r\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
});

test('readExport: unquoted commas in journey name are kept; short rows are skipped', () => {
  const r = readExport({ name: 'a.csv', text: csv(row('A, B, C', 1, V1, 'Anna', 'u1', 'Create', '10/13/2026 09:00:00 AM'), 'too, short') });
  assert.ok(r.ok);
  assert.equal(r.rows[0].journey, 'A,B,C');
  assert.equal(r.skipped, 1);
});

test('build: wrong file (core Salesforce Setup Audit Trail) is rejected by name', () => {
  const r = build([{ name: 'SetupAuditTrail.csv', text: 'Date,User,Source Namespace Prefix,Action,Section,Delegate User\n1,2,3,4,5,6' }]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'WRONG_FILE');
});

test('build: empty file, header-only file and no files are EMPTY', () => {
  for (const files of [[{ name: 'e.csv', text: '' }], [{ name: 'h.csv', text: HEADER }], []]) {
    const r = build(files);
    assert.equal(!r.ok && r.error.code, 'EMPTY');
  }
});

test('detectDateOrder: MDY, DMY, ambiguous and mixed', () => {
  assert.equal(detectDateOrder(['10/13/2026 09:00:00 AM']), 'MDY');
  assert.equal(detectDateOrder(['13/10/2026 09:00:00 AM']), 'DMY');
  assert.equal(detectDateOrder(['10/09/2026 09:00:00 AM']), null);
  assert.equal(detectDateOrder(['10/13/2026 09:00:00 AM', '13/10/2026 09:00:00 AM']), 'MIXED');
});

test('parseTime: 12 AM is midnight, 12 PM is noon, 24h works, invalid dates rejected', () => {
  const hhmm = (t: number | null) => t === null ? null : new Date(t).toISOString().slice(11, 16);
  assert.equal(hhmm(parseTime('10/13/2026 12:05:00 AM', 'MDY')), '00:05');
  assert.equal(hhmm(parseTime('10/13/2026 12:05:00 PM', 'MDY')), '12:05');
  assert.equal(hhmm(parseTime('10/13/2026 01:00:00 PM', 'MDY')), '13:00');
  assert.equal(hhmm(parseTime('13/10/2026 18:30:00', 'DMY')), '18:30');
  assert.equal(parseTime('02/31/2026 10:00:00 AM', 'MDY'), null);
  assert.equal(parseTime('10/13/2026 13:00:00 PM', 'MDY'), null);
  assert.equal(parseTime('garbage', 'MDY'), null);
});

test('build: all-ambiguous dates need an explicit order; DD/MM then works', () => {
  const text = csv(row('X_0926', 1, V1, 'A', 'u1', 'Create', '01/02/2026 09:00:00 AM'), row('X_0926', 1, V1, 'A', 'u1', 'Publish', '01/02/2026 09:01:00 AM'));
  const r = build([{ name: 'a.csv', text }]);
  assert.equal(!r.ok && r.error.code, 'AMBIGUOUS_DATE');
  const d = ok(build([{ name: 'a.csv', text }], { dateOrder: 'DMY' }));
  assert.equal(d.period.start, '2026-02-01T09:00:00');
  assert.equal(d.quality.dateFormat, 'DD/MM');
});

test('build: files with different date orders are rejected', () => {
  const a = csv(row('X', 1, V1, 'A', 'u1', 'Create', '10/13/2026 09:00:00 AM'));
  const b = csv(row('X', 1, V1, 'A', 'u1', 'Create', '13/10/2026 09:00:00 AM'));
  const r = build([{ name: 'a.csv', text: a }, { name: 'b.csv', text: b }]);
  assert.equal(!r.ok && r.error.code, 'MIXED_DATE_FORMATS');
});

test('build: scenario classifies tested, quick copy and edited versions', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO }]));
  assert.deepEqual(d.totals.classes, { tested: 1, unknown: 0, quick_copy: 1, edited: 1 });
  assert.equal(d.totals.versions, 3);
  assert.equal(d.totals.journeys, 2);
  assert.equal(d.totals.testRuns, 1);
  const promo = d.journeys.find(j => j.kind === 'campaign')!;
  assert.equal(promo.alias.mmyy, '10.26');
  assert.equal(promo.versions[0].modifies, 3);
  assert.equal(promo.versions[0].lastPublish, '2026-10-13T09:30:20');
  assert.equal(d.quality.simulationEvents, 1);
});

test('build: 12 AM times keep chronological order (00:30 → 01:10 is 40 minutes)', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO }]));
  const welcome = d.journeys.find(j => j.kind === 'journey')!;
  assert.equal(welcome.versions[0].minutesToPublish, 40);
  assert.equal(welcome.versions[0].cls, 'edited');
});

test('classify: SIMULATION after the last publish is not a test; created before window is unknown', () => {
  const after = csv(
    row('Y', 1, V1, 'A', 'u1', 'Create', '10/13/2026 09:00:00 AM'),
    row('Y', 1, V1, 'A', 'u1', 'Publish', '10/13/2026 09:00:30 AM'),
    row(`SIMULATION2 journeyId ${V1}`, 1, S1, 'A', 'u1', 'Create', '10/13/2026 10:00:00 AM'),
    row('Y', 2, V2, 'A', 'u1', 'Publish', '10/13/2026 11:00:00 AM'),
  );
  const d = ok(build([{ name: 'a.csv', text: after }]));
  const byVer = Object.fromEntries(versions(d).map(v => [v.version, v]));
  assert.equal(byVer[1].testRuns, 1);
  assert.equal(byVer[1].cls, 'quick_copy');
  assert.equal(byVer[2].cls, 'unknown');
});

test('classify: quick-copy boundary is inclusive at the threshold and at one Modify', () => {
  const base = { testedBeforePublish: false, created: '2026-10-13T09:00:00' };
  assert.equal(classify({ ...base, minutesToPublish: 2, modifies: 1 }, 2), 'quick_copy');
  assert.equal(classify({ ...base, minutesToPublish: 2.1, modifies: 1 }, 2), 'edited');
  assert.equal(classify({ ...base, minutesToPublish: 0.5, modifies: 2 }, 2), 'edited');
  assert.equal(classify({ ...base, created: null, minutesToPublish: null, modifies: 0 }, 2), 'unknown');
});

test('withThreshold: raising the threshold turns the 40-minute edit into a quick copy only if ≤ 1 Modify', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO }]));
  const d60 = withThreshold(d, 60);
  assert.equal(d60.totals.classes.edited, 0);
  assert.equal(d60.totals.classes.quick_copy, 2);
  assert.equal(d.totals.classes.edited, 1, 'input dataset is not mutated');
  assert.equal(d60.quality.quickCopyMinutes, 60);
});

test('build: overlapping exports without a BU label are deduplicated (regression: parity found 1 vs 101)', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO }, { name: 'b.csv', text: SCENARIO }]));
  assert.equal(d.quality.rawRows, 28);
  assert.equal(d.quality.exactDuplicates, 14);
  assert.equal(d.totals.versions, 3);
});

test('build: the same journey name in two BUs stays two journeys', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO, bu: 'Retail' }, { name: 'b.csv', text: SCENARIO, bu: 'SME' }]));
  assert.deepEqual(d.bus, ['Retail', 'SME']);
  assert.equal(d.totals.journeys, 4);
});

test('build: anonymized by default — no input name appears anywhere in the dataset', () => {
  const json = JSON.stringify(ok(build([{ name: 'acme-bank-audit.csv', text: SCENARIO }])));
  for (const secret of ['Anna', 'Boris', 'Promo_1026', 'Welcome', 'u1', 'u2', V1, V2, V3, 'acme']) assert.ok(!json.includes(secret), secret);
  const named = ok(build([{ name: 'a.csv', text: SCENARIO }], { keepNames: true }));
  assert.equal(named.people[0].name, 'Anna');
  assert.equal(named.anonymized, false);
});

test('metrics: people ranked by activity, heat uses Monday = 0, retention countdown from the oldest event', () => {
  const d = ok(build([{ name: 'a.csv', text: SCENARIO }]));
  assert.equal(d.people[0].n, 1);
  assert.ok(d.people[0].events >= d.people[1].events);
  // 13 Oct 2026 is a Tuesday → row 1, 09:00
  assert.ok(d.heat[1][9] > 0);
  assert.equal(d.period.days, 3);
  assert.equal(d.retention.oldestKept, '2026-10-13');
  assert.equal(d.retention.oldestDeletedOn, '2026-11-12');
});

test('kindOf: daily prefix, MMYY campaign suffix, otherwise always-on journey', () => {
  assert.equal(kindOf('daily_offer_LOW'), 'daily');
  assert.equal(kindOf('Promo_1026'), 'campaign');
  assert.equal(kindOf('Promo_1326'), 'journey');
  assert.equal(kindOf('Abandoned cart'), 'journey');
});

test('isSandbox: test, UAT, QA, smoke and unnamed "New Journey" are flagged; real campaigns are not', () => {
  for (const n of ['UAT_test_journey', 'smoke-test-email', 'QA - v2', 'New Journey - March 3 2026 at 9.15 AM', 'Anna_Test_V2', 'ivanov-self-test', 'Тест рассылки', 'Promo draft', 'Club_test'])
    assert.equal(isSandbox(n), true, n);
  // copies are how real campaigns are relaunched; A/B and split tests go to real customers
  for (const n of ['preapproved_card_0726', 'Abandoned Basket JRN', 'daily_offer_cards', 'Welcome series', 'Equalizer_1026', 'Contest_0926', 'Evaluation_survey', 'Latest offers',
    'Promo copy', 'Копия рассылки', 'Deposit_AB_test_1026', 'A/B test promo', 'ab-test cards', 'split_test_0926', 'Split test 1026'])
    assert.equal(isSandbox(n), false, n);
});

test('build + summarize: sandbox journeys are flagged and can be excluded from totals', () => {
  const text = csv(
    row('Promo_1026', 1, V1, 'Anna', 'u1', 'Create', '10/13/2026 09:00:00 AM'),
    row('Promo_1026', 1, V1, 'Anna', 'u1', 'Publish', '10/13/2026 09:30:00 AM'),
    row('UAT_test_journey', 1, V2, 'Boris', 'u2', 'Create', '10/14/2026 09:00:00 AM'),
    row('UAT_test_journey', 1, V2, 'Boris', 'u2', 'Publish', '10/14/2026 09:40:00 AM'),
    row('UAT_test_journey', 1, V2, 'Boris', 'u2', 'Stop', '10/14/2026 10:00:00 AM'),
  );
  const d = ok(build([{ name: 'a.csv', text }]));
  const work = summarize(d.journeys.filter(j => !j.sandbox)), sb = summarize(d.journeys.filter(j => j.sandbox));
  assert.equal(work.versions, 1);
  assert.equal(sb.versions, 1);
  assert.equal(sb.stops, 1);
  assert.equal(summarize(d.journeys).versions, d.totals.versions);
});

test('filterBu: one BU keeps journey keys and recounts totals; "*" and unknown BU return everything', () => {
  const text = (bu: string) => ({ name: `${bu}.csv`, bu, text: csv(
    row('Promo_1026', 1, V1, 'Anna', 'u1', 'Create', '10/13/2026 09:00:00 AM'),
    row('Promo_1026', 1, V1, 'Anna', 'u1', 'Publish', '10/13/2026 09:30:00 AM'),
    ...(bu === 'B' ? [row('Promo_1026', 1, V1, 'Anna', 'u1', 'Stop', '10/14/2026 09:30:00 AM')] : [])) });
  const r = build([text('A'), text('B')]);
  assert.ok(r.ok);
  const d = r.data, b = filterBu(d, 'B');
  assert.equal(b.journeys.length, 1);
  assert.equal(b.journeys[0].key, d.journeys.find(j => j.bu === 'B')!.key);
  assert.equal(b.totals.versions, 1);
  assert.equal(b.totals.events, 3);
  assert.equal(filterBu(d, '*'), d);
  assert.equal(filterBu(d, 'nope'), d);
});

test('performance: 100k rows build in under 2 s (regression: array spreads were O(n²))', () => {
  const rows: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    const d = new Date(Date.UTC(2026, 8, 13) + i * 60_000), p = (x: number) => String(x).padStart(2, '0');
    const h = d.getUTCHours() % 12 || 12, ap = d.getUTCHours() >= 12 ? 'PM' : 'AM';
    const vid = `00000000-0000-0000-0000-${String(Math.floor(i / 4)).padStart(12, '0')}`;
    rows.push(row('daily_offer', Math.floor(i / 4) + 1, vid, 'A', 'u1', ['Create', 'Modify', 'Modify', 'Publish'][i % 4], `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(h)}:${p(d.getUTCMinutes())}:00 ${ap}`));
  }
  const t0 = performance.now();
  const d = ok(build([{ name: 'big.csv', text: csv(...rows) }]));
  const elapsed = performance.now() - t0;
  assert.equal(d.totals.versions, 25_000);
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
});
