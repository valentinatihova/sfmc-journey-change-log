import assert from 'node:assert/strict';
import test from 'node:test';
import { build, summarize } from './core.ts';
import { generate, PROFILES } from './gen-sample.ts';

const END = new Date('2026-10-11T00:00:00Z');

test('gen-sample: every profile is a valid export, deterministic per seed, different per profile', () => {
  const headline = new Set<string>();
  for (const p of Object.keys(PROFILES)) {
    const csv = generate(p, 1, END);
    assert.equal(csv, generate(p, 1, END), `${p} is deterministic`);
    assert.notEqual(csv, generate(p, 2, END), `${p} changes with the seed`);
    const r = build([{ name: `${p}.csv`, text: csv }]);
    assert.ok(r.ok, `${p} parses`);
    const last = r.data.period.end.slice(0, 10);
    assert.ok(last <= '2026-10-11' && last >= '2026-10-06', `${p} ends near --end (${last})`);
    assert.ok(r.data.totals.testRuns > 0, `${p} has Test-mode runs`);
    const w = summarize(r.data.journeys.filter(j => !j.sandbox));
    headline.add(`${w.classes.tested}/${w.versions}`);
  }
  assert.equal(headline.size, Object.keys(PROFILES).length, 'profiles tell different stories');
});

test('gen-sample: bank has test journeys in production, retail none, agency exports DD/MM', () => {
  const data = (p: string) => { const r = build([{ name: p, text: generate(p, 1, END) }]); assert.ok(r.ok); return r.data; };
  const bank = data('bank'), retail = data('retail'), agency = data('agency');
  assert.ok(summarize(bank.journeys.filter(j => j.sandbox)).versions > bank.totals.versions / 3);
  assert.equal(retail.journeys.filter(j => j.sandbox).length, 0);
  assert.equal(agency.quality.dateFormat, 'DD/MM');
});
