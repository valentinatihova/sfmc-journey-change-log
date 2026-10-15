/**
 * Synthetic Journey Builder Audit Log exports for demos and interviews. No client data:
 * names, journeys and IDs are generated from a seed, so the same profile + seed gives the same file.
 *
 *   node src/gen-sample.ts --profile bank|retail|agency [--seed 1] [--end 2026-10-11] [--out file.csv]
 *   node src/gen-sample.ts --all --dir out/        # all three profiles
 *
 * Row format matches a real export: newest first, "SIMULATION<n> journeyId <versionId>" rows for
 * Test-mode runs, MM/DD (or DD/MM for the agency profile) with 12-hour time, no time zone.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Kind = 'campaign' | 'daily' | 'journey' | 'sandbox';
interface Profile {
  title: string; days: number; dateOrder: 'MDY' | 'DMY';
  people: Array<[name: string, weight: number]>;
  /** launches over the period, per kind */
  launches: Record<Kind, number>;
  /** share of launches tested in Test mode before going live, per kind */
  testRate: Record<Kind, number>;
  /** share of launches that are a relaunch of a copy without edits */
  quickCopyRate: number;
  offHoursRate: number; stopRate: number;
  /** who launches test journeys (indexes into people) */
  sandboxPeople: number[];
}

export const PROFILES: Record<string, Profile> = {
  bank: {
    title: 'Банк: тестовые кампании в рабочем BU', days: 30, dateOrder: 'MDY',
    people: [['Anna Petrova', 9], ['Mark Davtyan', 7], ['Olga Sim', 1], ['Ivan Orlov', 0], ['Lena Kim', 0], ['Pavel Gor', 0]],
    launches: { campaign: 26, daily: 8, journey: 3, sandbox: 40 },
    testRate: { campaign: 0.96, daily: 1, journey: 0.5, sandbox: 0.3 },
    quickCopyRate: 0.04, offHoursRate: 0.05, stopRate: 0.12, sandboxPeople: [0, 1, 3, 4, 5],
  },
  retail: {
    title: 'Ритейл: дисциплинированная команда', days: 30, dateOrder: 'MDY',
    people: [['Maria Lopez', 3], ['Tom Becker', 3], ['Sara Novak', 2], ['Ken Ito', 2]],
    launches: { campaign: 34, daily: 12, journey: 6, sandbox: 0 },
    testRate: { campaign: 0.97, daily: 1, journey: 0.9, sandbox: 1 },
    quickCopyRate: 0.02, offHoursRate: 0.02, stopRate: 0.05, sandboxPeople: [],
  },
  agency: {
    title: 'Агентство: всё на скорость', days: 30, dateOrder: 'DMY',
    people: [['Alex Hart', 4], ['Nina Volk', 3], ['Raj Mehta', 3], ['Eva Stone', 2], ['Leo Park', 2], ['Mia Ford', 1], ['Ben Cruz', 1], ['Zoe Lane', 1]],
    launches: { campaign: 52, daily: 10, journey: 8, sandbox: 9 },
    testRate: { campaign: 0.55, daily: 0.7, journey: 0.25, sandbox: 0.2 },
    quickCopyRate: 0.18, offHoursRate: 0.22, stopRate: 0.1, sandboxPeople: [4, 5, 6],
  },
};

const NAMES: Record<Kind, string[]> = {
  campaign: ['Promo_Cashback', 'Card_Launch', 'Deposit_Rate', 'Black_Friday', 'Loan_Offer', 'Insurance_Upsell', 'Travel_Card', 'Refer_Friend', 'Win_Back', 'Payroll_Switch', 'Autumn_Sale', 'Premium_Upgrade'],
  daily: ['daily_offer_cards', 'daily_loan_reminder', 'daily_birthday', 'daily_payment_due'],
  journey: ['Welcome series', 'Abandoned application JRN', 'Onboarding app', 'Reactivation 90d'],
  sandbox: ['UAT_test_journey', 'smoke-test-push', 'QA - email layout', 'New Journey - September 18 2026 at 3.42 PM', 'test_segment_check', 'Draft promo v2'],
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function generate(profileName: string, seed = 1, end = new Date(Date.now() - 864e5)): string {
  const P = PROFILES[profileName];
  if (!P) throw new Error(`unknown profile ${profileName}; use ${Object.keys(PROFILES).join(', ')}`);
  const r = rng(seed * 7919 + profileName.length);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const v = Math.floor(r() * 16); return (c === 'x' ? v : (v & 3) | 8).toString(16); });
  const people = P.people.map(([name], i) => ({ name, id: String(710000100 + i + seed * 100) }));
  const weighted = (idx: number[]) => {
    const pool = idx.flatMap(i => Array(Math.max(1, P.people[i][1])).fill(i));
    return people[pick(pool)];
  };
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const startDay = endDay - (P.days - 1) * 864e5;
  const mmyy = (t: number) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCFullYear()).slice(2)}`; };

  type Row = { journey: string; version: number; vid: string; who: { name: string; id: string }; action: string; t: number };
  const rows: Row[] = [];
  const versions = new Map<string, number>();
  let sim = 900;

  const launchTime = () => {
    const day = startDay + Math.floor(r() * P.days) * 864e5;
    const off = r() < P.offHoursRate;
    const hour = off ? pick([6, 7, 21, 22, 23]) : 9 + Math.floor(r() * 9);
    let t = day + hour * 36e5 + Math.floor(r() * 60) * 6e4;
    const wd = (new Date(t).getUTCDay() + 6) % 7;
    if (!off && wd >= 5) t -= (wd - 4) * 864e5; // working launches move to Friday
    return Math.max(t, startDay + 9 * 36e5);
  };

  const all = Object.keys(people).map(Number);
  const workers = all.filter(i => P.people[i][1] > 0);
  // plan launches first, then number versions per journey in time order
  const plan = (['campaign', 'daily', 'journey', 'sandbox'] as Kind[]).flatMap(kind => Array.from({ length: P.launches[kind] }, () => {
    const publishAt = launchTime(), base = pick(NAMES[kind]);
    return { kind, publishAt, name: kind === 'campaign' ? `${base}_${mmyy(publishAt)}` : base };
  })).sort((a, b) => a.publishAt - b.publishAt);
  {
    for (const { kind, publishAt, name } of plan) {
      const v = (versions.get(name) ?? Math.floor(r() * 20) + 1) + 1;
      versions.set(name, v);
      const vid = uuid();
      const who = weighted(kind === 'sandbox' ? (P.sandboxPeople.length ? P.sandboxPeople : workers) : workers);
      const quick = kind !== 'sandbox' && r() < P.quickCopyRate;
      const tested = !quick && r() < P.testRate[kind];
      const minutes = quick ? 1 + Math.floor(r() * 2) : 8 + Math.floor(r() * 90);
      const created = publishAt - minutes * 6e4;
      rows.push({ journey: name, version: v, vid, who, action: 'Create', t: created });
      const mods = quick ? Math.floor(r() * 2) : 1 + Math.floor(r() * 8);
      for (let m = 1; m <= mods; m++) rows.push({ journey: name, version: v, vid, who, action: 'Modify', t: created + Math.floor((publishAt - created) * m / (mods + 2)) });
      if (tested) {
        const runs = 1 + (r() < 0.25 ? 1 : 0);
        for (let k = 0; k < runs; k++) {
          const st = publishAt - Math.floor((publishAt - created) * (0.3 - k * 0.1)) ;
          const sname = `SIMULATION${sim++} journeyId ${vid}`, sid = uuid();
          rows.push({ journey: sname, version: 1, vid: sid, who, action: 'Create', t: st });
          rows.push({ journey: sname, version: 1, vid: sid, who, action: 'Publish', t: st + 2000 });
          rows.push({ journey: sname, version: 1, vid: sid, who, action: 'Stop', t: st + 5 * 6e4 });
        }
      }
      rows.push({ journey: name, version: v, vid, who, action: 'Publish', t: publishAt });
      if (r() < 0.6) rows.push({ journey: name, version: v, vid, who, action: 'Publish', t: publishAt + 9000 }); // SFMC often logs a repeated Publish
      if (r() < P.stopRate) rows.push({ journey: name, version: v, vid, who, action: 'Stop', t: publishAt + (2 + Math.floor(r() * 40)) * 36e5 });
    }
  }

  const fmt = (t: number) => {
    const d = new Date(t), h = d.getUTCHours(), p = (x: number) => String(x).padStart(2, '0');
    const [a, b] = P.dateOrder === 'MDY' ? [d.getUTCMonth() + 1, d.getUTCDate()] : [d.getUTCDate(), d.getUTCMonth() + 1];
    return `${p(a)}/${p(b)}/${d.getUTCFullYear()} ${p(h % 12 || 12)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const lines = rows.filter(x => x.t <= endDay + 864e5 - 1000).sort((a, b) => b.t - a.t)
    .map(x => `${x.journey}, ${x.version}, ${x.vid}, ${x.who.name}, ${x.who.id}, ${x.action}, ${fmt(x.t)}`);
  return ['Journey Name, Version, Journey ID, User Name, User ID, Action, Time', ...lines].join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const seed = Number(val('--seed') ?? 1), end = val('--end') ? new Date(val('--end') + 'T00:00:00Z') : undefined;
  if (args.includes('--all')) {
    const dir = val('--dir') ?? '.';
    mkdirSync(dir, { recursive: true });
    for (const p of Object.keys(PROFILES)) { const f = join(dir, `audit-log-${p}.csv`); writeFileSync(f, generate(p, seed, end)); console.log(f, '·', PROFILES[p].title); }
  } else {
    const csv = generate(val('--profile') ?? 'bank', seed, end), out = val('--out');
    if (out) writeFileSync(out, csv); else process.stdout.write(csv);
  }
}
