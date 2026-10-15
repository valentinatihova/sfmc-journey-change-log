/**
 * Journey Change Log core: Journey Builder Audit Log CSV exports → Dataset.
 *
 *   InputFile[] ─► parseCsv ─► readExport (header check, rows) ─► detectDateOrder
 *        ─► toEvents (naive local time) ─► dedupe across files
 *        ─► split SIMULATION runs ─► one record per activated version
 *        ─► classify: tested | unknown | quick_copy | edited ─► metrics ─► Dataset
 *
 * Pure functions: no DOM, no network, no time zones. Times stay exactly as SFMC
 * exported them ("naive" local time); `Date.UTC` is only used as a container
 * for arithmetic, and every read uses the getUTC* accessors.
 *
 * Classification:
 *   tested      a SIMULATION of this version was created before its last publish
 *   unknown     no SIMULATION visible and the version was created before the export window
 *   quick_copy  untested, first publish ≤ quickCopyMinutes after create and ≤ 1 Modify
 *   edited      untested otherwise
 */

export type DateOrder = 'MDY' | 'DMY';
export type VersionClass = 'tested' | 'unknown' | 'quick_copy' | 'edited';
export type JourneyKind = 'campaign' | 'daily' | 'journey';
export type ErrorCode = 'EMPTY' | 'WRONG_FILE' | 'AMBIGUOUS_DATE' | 'MIXED_DATE_FORMATS';

export interface InputFile { name: string; text: string; bu?: string }
export interface BuildOptions { dateOrder?: DateOrder; quickCopyMinutes?: number; keepNames?: boolean }
export interface BuildError { code: ErrorCode; file?: string; detail?: string }

export interface Person { key: string; n: number; name?: string; events: number; published: number; edited: number }
export interface Version {
  journeyKey: string; version: number; created: string | null; firstPublish: string; lastPublish: string;
  publisher: string; modifies: number; testRuns: number; testedBeforePublish: boolean;
  minutesToPublish: number | null; cls: VersionClass;
}
export interface Journey {
  key: string; bu: string; kind: JourneyKind; alias: { n: number; mmyy: string | null }; name?: string;
  /** Detected by name (test, UAT, QA, sandbox, "New Journey …"); the app lets the user override it. */
  sandbox: boolean;
  editors: string[]; stops: number; events: number; last: string; versions: Version[];
}
export interface Dataset {
  anonymized: boolean;
  bus: string[];
  period: { start: string; end: string; days: number };
  retention: { days: number; anchor: string; oldestKept: string; oldestDeletedOn: string };
  totals: { versions: number; journeys: number; editors: number; events: number; testRuns: number; classes: Record<VersionClass, number> };
  journeys: Journey[];
  heat: number[][];
  people: Person[];
  quality: {
    rawRows: number; exactDuplicates: number; skippedRows: number; dateFormat: 'MM/DD' | 'DD/MM';
    simulationEvents: number; quickCopyMinutes: number; files: { name: string; bu: string; rows: number }[];
  };
}
export type BuildResult = { ok: true; data: Dataset } | { ok: false; error: BuildError };

export const RETENTION_DAYS = 30;
export const DEFAULT_QUICK_COPY_MINUTES = 2;
export const DEFAULT_BU = 'BU';
const HEADER_TAIL = ['version', 'journey id', 'user name', 'user id', 'action', 'time'];
const SIM_RE = /^SIMULATION\d*\s+journeyId\s+([0-9a-f-]{36})/i;
const MMYY_RE = /_(0[1-9]|1[0-2])(\d\d)(?=$|_|\b)/;
/**
 * Test and scratch journeys that live in a production BU. "copy" is deliberately absent:
 * copying last month's journey and relaunching it is how real campaigns are made.
 * "test" preceded by A/B or split is a real experiment sent to customers.
 */
export const SANDBOX_RE = /(?<![a-zа-яё])(?<!(?<![a-z])a\s?\/?\s?b[\s_-]?)(?<!split[\s_-]?)(?:test|uat|qa|sandbox|smoke|draft|тест|черновик)(?![a-zа-яё])|^new journey\b/i;
const TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;
const DAY_MS = 864e5;

// ── CSV ──────────────────────────────────────────────────────────────────────
/** RFC 4180 parser: quoted fields, "" escapes, CRLF/LF, BOM. Fields are trimmed; blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, i = 0;
  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => { endField(); if (row.some(f => f !== '')) rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field.trim() === '') { field = ''; quoted = true; }
    else if (c === ',') endField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; endRow(); }
    else field += c;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

interface RawRow { journey: string; version: number; versionId: string; userName: string; userId: string; action: string; time: string }

/** Validates the export header and splits rows. Journey names may contain unquoted commas: the last six fields are fixed. */
export function readExport(file: InputFile): { ok: true; rows: RawRow[]; skipped: number } | { ok: false; error: BuildError } {
  const rows = parseCsv(file.text);
  if (rows.length === 0) return { ok: false, error: { code: 'EMPTY', file: file.name } };
  const header = rows[0].map(h => h.toLowerCase());
  const tail = header.slice(-6);
  if (header.length < 7 || !header[0].includes('journey') || tail.join('|') !== HEADER_TAIL.join('|')) {
    return { ok: false, error: { code: 'WRONG_FILE', file: file.name, detail: rows[0].slice(0, 8).join(', ') } };
  }
  const out: RawRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    if (r.length < 7) { skipped++; continue; }
    const [ver, versionId, userName, userId, action, time] = r.slice(-6);
    const version = Number(ver);
    if (!Number.isInteger(version) || !versionId || !action || !time) { skipped++; continue; }
    out.push({ journey: r.slice(0, -6).join(',').trim(), version, versionId, userName, userId, action, time });
  }
  return { ok: true, rows: out, skipped };
}

// ── dates ────────────────────────────────────────────────────────────────────
/** MDY if some day-position value > 12 in the 2nd field, DMY if in the 1st; null if every row is ambiguous. */
export function detectDateOrder(times: string[]): DateOrder | 'MIXED' | null {
  let mdy = false, dmy = false;
  for (const t of times) {
    const m = TIME_RE.exec(t.trim());
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (b > 12) mdy = true;
    if (a > 12) dmy = true;
  }
  if (mdy && dmy) return 'MIXED';
  return mdy ? 'MDY' : dmy ? 'DMY' : null;
}

/** Parses "10/09/2026 01:00:27 PM" (12h) or "10/09/2026 13:00:27" (24h) into naive epoch ms; null if invalid. */
export function parseTime(s: string, order: DateOrder): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [month, day] = order === 'MDY' ? [a, b] : [b, a];
  let hour = Number(m[4]);
  const minute = Number(m[5]), second = Number(m[6] ?? 0), ampm = m[7]?.toUpperCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'AM' && hour === 12) hour = 0;
    if (ampm === 'PM' && hour !== 12) hour += 12;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const t = Date.UTC(y, month - 1, day, hour, minute, second);
  return new Date(t).getUTCDate() === day ? t : null; // rejects 31/02
}

export const iso = (t: number): string => new Date(t).toISOString().slice(0, 19);
const isoDate = (t: number): string => new Date(t).toISOString().slice(0, 10);
const dayStart = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

// ── model ────────────────────────────────────────────────────────────────────
interface Event { journey: string; version: number; versionId: string; userName: string; userId: string; action: string; t: number; bu: string }

export const isSandbox = (name: string): boolean => SANDBOX_RE.test(name.trim());

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

export function kindOf(name: string): JourneyKind {
  if (name.toLowerCase().startsWith('daily')) return 'daily';
  return MMYY_RE.test(name) ? 'campaign' : 'journey';
}

export function classify(v: Pick<Version, 'testedBeforePublish' | 'created' | 'minutesToPublish' | 'modifies'>, quickCopyMinutes: number): VersionClass {
  if (v.testedBeforePublish) return 'tested';
  if (v.created === null || v.minutesToPublish === null) return 'unknown';
  return v.minutesToPublish <= quickCopyMinutes && v.modifies <= 1 ? 'quick_copy' : 'edited';
}

const emptyClasses = (): Record<VersionClass, number> => ({ tested: 0, unknown: 0, quick_copy: 0, edited: 0 });

/** Re-classifies every version with a new quick-copy threshold; returns a new Dataset (input untouched). */
export function withThreshold(data: Dataset, quickCopyMinutes: number): Dataset {
  const classes = emptyClasses();
  const editedBy = new Map<string, number>();
  const journeys = data.journeys.map(j => ({
    ...j,
    versions: j.versions.map(v => {
      const cls = classify(v, quickCopyMinutes);
      classes[cls]++;
      if (cls === 'edited') editedBy.set(v.publisher, (editedBy.get(v.publisher) ?? 0) + 1);
      return { ...v, cls };
    }),
  }));
  return {
    ...data, journeys,
    totals: { ...data.totals, classes },
    people: data.people.map(p => ({ ...p, edited: editedBy.get(p.key) ?? 0 })),
    quality: { ...data.quality, quickCopyMinutes },
  };
}

export interface Summary { journeys: number; versions: number; stops: number; classes: Record<VersionClass, number> }

/** Totals for any subset of journeys (e.g. working vs sandbox). */
export function summarize(journeys: Journey[]): Summary {
  const classes = emptyClasses();
  let versions = 0, stops = 0;
  for (const j of journeys) {
    stops += j.stops;
    for (const v of j.versions) { classes[v.cls]++; versions++; }
  }
  return { journeys: journeys.length, versions, stops, classes };
}

/**
 * One BU of a multi-BU dataset without rebuilding: journey keys stay stable, so
 * per-journey UI state (selection, test-campaign overrides) survives a BU switch.
 */
export function filterBu(data: Dataset, bu: string): Dataset {
  if (bu === '*' || !data.bus.includes(bu)) return data;
  const journeys = data.journeys.filter(j => j.bu === bu), sum = summarize(journeys);
  return {
    ...data,
    journeys,
    totals: {
      ...data.totals,
      journeys: sum.journeys, versions: sum.versions, classes: sum.classes,
      editors: new Set(journeys.flatMap(j => j.editors)).size,
      events: journeys.reduce((a, j) => a + j.events, 0),
      testRuns: journeys.reduce((a, j) => a + j.versions.reduce((b, v) => b + v.testRuns, 0), 0),
    },
  };
}

export function build(files: InputFile[], opts: BuildOptions = {}): BuildResult {
  const quickCopyMinutes = opts.quickCopyMinutes ?? DEFAULT_QUICK_COPY_MINUTES;
  if (files.length === 0) return { ok: false, error: { code: 'EMPTY' } };

  // 1. read and validate every file
  const read: { file: InputFile; bu: string; rows: RawRow[] }[] = [];
  let skipped = 0;
  for (const file of files) {
    const r = readExport(file);
    if (!r.ok) return r;
    skipped += r.skipped;
    // Unlabelled files belong to one BU: overlapping exports of the same BU must deduplicate.
    read.push({ file, bu: file.bu?.trim() || DEFAULT_BU, rows: r.rows });
  }
  const rawRows = read.reduce((a, f) => a + f.rows.length, 0);
  if (rawRows === 0) return { ok: false, error: { code: 'EMPTY', file: files.map(f => f.name).join(', ') } };

  // 2. one date order for all files
  const orders = read.map(f => ({ name: f.file.name, order: detectDateOrder(f.rows.map(r => r.time)) }));
  const mixedIn = orders.find(o => o.order === 'MIXED');
  if (mixedIn) return { ok: false, error: { code: 'MIXED_DATE_FORMATS', file: mixedIn.name } };
  const known = [...new Set(orders.map(o => o.order).filter((o): o is DateOrder => o === 'MDY' || o === 'DMY'))];
  if (known.length > 1) return { ok: false, error: { code: 'MIXED_DATE_FORMATS', detail: orders.map(o => `${o.name}: ${o.order ?? '?'}`).join('; ') } };
  const order = known[0] ?? opts.dateOrder;
  if (!order) return { ok: false, error: { code: 'AMBIGUOUS_DATE' } };

  // 3. events, exact duplicates removed across files
  const seen = new Set<string>();
  const events: Event[] = [];
  for (const f of read) for (const r of f.rows) {
    const t = parseTime(r.time, order);
    if (t === null) { skipped++; continue; }
    const key = [f.bu, r.journey, r.version, r.versionId, r.userName, r.userId, r.action, t].join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ journey: r.journey, version: r.version, versionId: r.versionId, userName: r.userName, userId: r.userId, action: r.action, t, bu: f.bu });
  }
  if (events.length === 0) return { ok: false, error: { code: 'EMPTY' } };
  events.sort((a, b) => a.t - b.t);

  const sims = events.filter(e => SIM_RE.test(e.journey));
  const real = events.filter(e => !SIM_RE.test(e.journey));
  const simCreates = new Map<string, number[]>();
  for (const s of sims) {
    const m = SIM_RE.exec(s.journey);
    if (m && s.action === 'Create') push(simCreates, m[1], s.t);
  }

  // 4. people ranked by real events; pseudonym number = rank
  const userCount = new Map<string, number>(), userName = new Map<string, string>();
  for (const e of real) { userCount.set(e.userId, (userCount.get(e.userId) ?? 0) + 1); if (!userName.has(e.userId)) userName.set(e.userId, e.userName); }
  const ranked = [...userCount.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const personKey = new Map(ranked.map((u, i) => [u, `p${i + 1}`]));

  // 5. journeys keyed by BU + name; aliases numbered per kind by activity
  const jKey = (e: Event) => `${e.bu}\u0001${e.journey}`;
  const jEvents = new Map<string, Event[]>();
  for (const e of real) push(jEvents, jKey(e), e);
  const jOrder = [...jEvents.entries()].sort((a, b) => b[1].length - a[1].length);
  const kindCount: Record<JourneyKind, number> = { campaign: 0, daily: 0, journey: 0 };
  const journeyMeta = new Map<string, { key: string; kind: JourneyKind; n: number; mmyy: string | null }>();
  jOrder.forEach(([k, es], i) => {
    const kind = kindOf(es[0].journey);
    const m = MMYY_RE.exec(es[0].journey);
    journeyMeta.set(k, { key: `j${i + 1}`, kind, n: ++kindCount[kind], mmyy: kind === 'campaign' && m ? `${m[1]}.${m[2]}` : null });
  });

  // 6. one record per activated version
  const byVersion = new Map<string, Event[]>();
  for (const e of real) push(byVersion, `${e.bu}\u0001${e.versionId}`, e);
  const versionsByJourney = new Map<string, Version[]>();
  const published = new Map<string, number>();
  for (const es of byVersion.values()) {
    const pubs = es.filter(e => e.action === 'Publish');
    if (pubs.length === 0) continue;
    const last = pubs.reduce((a, b) => (b.t >= a.t ? b : a));
    const firstPub = Math.min(...pubs.map(p => p.t));
    const creates = es.filter(e => e.action === 'Create').map(e => e.t);
    const created = creates.length ? Math.min(...creates) : null;
    const runs = simCreates.get(es[0].versionId) ?? [];
    const v: Omit<Version, 'cls'> = {
      journeyKey: journeyMeta.get(jKey(es[0]))!.key,
      version: es[0].version,
      created: created === null ? null : iso(created),
      firstPublish: iso(firstPub),
      lastPublish: iso(last.t),
      publisher: personKey.get(last.userId)!,
      modifies: es.filter(e => e.action === 'Modify' && e.t <= last.t).length,
      testRuns: runs.length,
      testedBeforePublish: runs.some(t => t <= last.t),
      minutesToPublish: created === null ? null : Math.round(((firstPub - created) / 6e4) * 10) / 10,
    };
    const full = { ...v, cls: classify(v, quickCopyMinutes) };
    const jk = jKey(es[0]);
    push(versionsByJourney, jk, full);
    published.set(full.publisher, (published.get(full.publisher) ?? 0) + 1);
  }

  const journeys: Journey[] = jOrder.map(([k, es]) => {
    const meta = journeyMeta.get(k)!;
    const versions = (versionsByJourney.get(k) ?? []).sort((a, b) => a.firstPublish.localeCompare(b.firstPublish));
    return {
      key: meta.key, bu: es[0].bu, kind: meta.kind, alias: { n: meta.n, mmyy: meta.mmyy }, sandbox: isSandbox(es[0].journey),
      ...(opts.keepNames ? { name: es[0].journey } : {}),
      editors: [...new Set(es.map(e => personKey.get(e.userId)!))],
      stops: es.filter(e => e.action === 'Stop').length,
      events: es.length,
      last: iso(Math.max(...es.map(e => e.t))),
      versions,
    };
  }).sort((a, b) => b.versions.length - a.versions.length || b.events - a.events);

  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const e of real) { const d = new Date(e.t); heat[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++; }

  const start = events[0].t, end = events[events.length - 1].t;
  const people: Person[] = ranked.map((u, i) => ({
    key: `p${i + 1}`, n: i + 1, ...(opts.keepNames ? { name: userName.get(u) } : {}),
    events: userCount.get(u)!, published: published.get(`p${i + 1}`) ?? 0, edited: 0,
  }));

  const base: Dataset = {
    anonymized: !opts.keepNames,
    bus: [...new Set(read.map(f => f.bu))],
    period: { start: iso(start), end: iso(end), days: Math.round((dayStart(end) - dayStart(start)) / DAY_MS) + 1 },
    retention: { days: RETENTION_DAYS, anchor: isoDate(end), oldestKept: isoDate(start), oldestDeletedOn: isoDate(dayStart(start) + RETENTION_DAYS * DAY_MS) },
    totals: { versions: 0, journeys: journeys.length, editors: people.length, events: real.length, testRuns: sims.filter(s => s.action === 'Create').length, classes: emptyClasses() },
    journeys, heat, people,
    quality: {
      rawRows, exactDuplicates: rawRows - events.length - countUnparsed(read, order), skippedRows: skipped,
      dateFormat: order === 'MDY' ? 'MM/DD' : 'DD/MM', simulationEvents: sims.length, quickCopyMinutes,
      files: read.map(f => ({ name: f.file.name, bu: f.bu, rows: f.rows.length })),
    },
  };
  base.totals.versions = journeys.reduce((a, j) => a + j.versions.length, 0);
  return { ok: true, data: withThreshold(base, quickCopyMinutes) };
}

function countUnparsed(read: { rows: RawRow[] }[], order: DateOrder): number {
  let n = 0;
  for (const f of read) for (const r of f.rows) if (parseTime(r.time, order) === null) n++;
  return n;
}
