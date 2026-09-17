/**
 * stats.mjs — filtragem e estatistica de series de commits/dia.
 *
 * Modulo puro: sem imports de node, sem DOM. Roda igual no script de build
 * (node) e no dashboard (browser, via <script type="module">). E a UNICA fonte
 * de verdade dos numeros — o SVG do README e a pagina interativa consomem daqui,
 * entao nunca divergem.
 */

export const MS_DAY = 86400000;
export const BUSINESS_DAYS = [1, 2, 3, 4, 5]; // seg..sex
export const WEEKDAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
export const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** 'YYYY-MM-DD' -> ms UTC. */
export function dayToMs(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** ms UTC -> 'YYYY-MM-DD'. */
export function msToDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function shiftDay(day, n) {
  return msToDay(dayToMs(day) + n * MS_DAY);
}

/** 0=dom .. 6=sab */
export function weekdayOf(day) {
  return new Date(dayToMs(day)).getUTCDay();
}

export function daysBetween(from, to) {
  return Math.round((dayToMs(to) - dayToMs(from)) / MS_DAY) + 1;
}

/**
 * Expande o intervalo dia a dia, ja aplicando o filtro de dias da semana.
 * Inclui dias com zero commit — sao dados, nao ausencia de dados: sem eles a
 * media viraria "media dos dias em que eu commitei", que e outra pergunta.
 */
export function expandRange(from, to, weekdays) {
  const allow = new Set(weekdays && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]);
  const out = [];
  const end = dayToMs(to);
  for (let ms = dayToMs(from); ms <= end; ms += MS_DAY) {
    const wd = new Date(ms).getUTCDay();
    if (allow.has(wd)) out.push({ day: msToDay(ms), weekday: wd });
  }
  return out;
}

/** Soma de um dia, opcionalmente restrita a um subconjunto de repos. */
function dayCount(entry, repoFilter) {
  if (!entry) return 0;
  if (!repoFilter) return entry.n;
  let n = 0;
  for (const key of repoFilter) n += (entry.r && entry.r[key]) || 0;
  return n;
}

/**
 * Serie diaria filtrada: [{ day, weekday, n }]
 * opts: { from, to, weekdays: number[], repos: string[]|null }
 */
export function dailySeries(data, opts = {}) {
  const from = opts.from || data.firstDay;
  const to = opts.to || data.lastDay;
  const repoFilter = opts.repos && opts.repos.length && opts.repos.length !== (data.repos || []).length
    ? new Set(opts.repos)
    : null;
  return expandRange(from, to, opts.weekdays).map(({ day, weekday }) => ({
    day,
    weekday,
    n: dayCount(data.days[day], repoFilter),
  }));
}

/** Segunda-feira da semana ISO do dia. */
function weekStart(day) {
  const wd = weekdayOf(day);
  return shiftDay(day, wd === 0 ? -6 : 1 - wd);
}

/**
 * Agrupa a serie diaria em dia | semana | mes.
 * `days` guarda quantos dias do filtro cairam no bucket — e o que permite dizer
 * "13 commits em 4 dias uteis" em vez de fingir que a semana teve 7 dias.
 */
export function bucketize(series, granularity) {
  if (granularity === 'day') {
    return series.map((p) => ({ key: p.day, start: p.day, end: p.day, n: p.n, days: 1 }));
  }
  const keyOf = granularity === 'week' ? weekStart : (d) => d.slice(0, 7);
  const map = new Map();
  for (const p of series) {
    const key = keyOf(p.day);
    let b = map.get(key);
    if (!b) map.set(key, (b = { key, start: p.day, end: p.day, n: 0, days: 0 }));
    if (p.day < b.start) b.start = p.day;
    if (p.day > b.end) b.end = p.day;
    b.n += p.n;
    b.days += 1;
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Percentil por interpolacao linear (metodo 7 do R / default do numpy). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function describe(values) {
  const total = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    total,
    mean: values.length ? total / values.length : 0,
    median: median(values),
    p25: percentile(values, 0.25),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : 0,
  };
}

/**
 * Streaks contados SOBRE A SERIE FILTRADA: com filtro de dias uteis, um fim de
 * semana sem commit nao quebra a sequencia (ele nem existe na serie). E a
 * leitura que importa pra "streak de dias uteis".
 */
export function streaks(series) {
  let longest = 0, run = 0;
  for (const p of series) {
    if (p.n > 0) { run += 1; if (run > longest) longest = run; }
    else run = 0;
  }
  return { current: run, longest };
}

/** Distribuicao por dia da semana. */
export function byWeekday(series) {
  const acc = WEEKDAY_LABELS.map((label, wd) => ({ wd, label, total: 0, days: 0 }));
  for (const p of series) { acc[p.weekday].total += p.n; acc[p.weekday].days += 1; }
  return acc.map((a) => ({ ...a, mean: a.days ? a.total / a.days : 0 }));
}

/**
 * Tudo que a UI precisa, de uma vez.
 *
 * Duas medias, de proposito:
 *  - perDay:    todos os dias do filtro (com zeros) -> "commits por dia util"
 *  - perActive: so os dias com >=1 commit           -> "quando commito, commito quanto"
 * A primeira e a honesta pra ritmo; a segunda pra intensidade. A mediana com
 * zeros costuma ser baixa (ou 0) — isso e o dado, nao um bug.
 */
export function analyze(data, opts = {}) {
  const granularity = opts.granularity || 'day';
  const series = dailySeries(data, opts);
  const buckets = bucketize(series, granularity);
  const values = series.map((p) => p.n);
  const active = values.filter((v) => v > 0);
  const peak = series.reduce((best, p) => (p.n > (best ? best.n : -1) ? p : best), null);

  return {
    granularity,
    from: series.length ? series[0].day : opts.from,
    to: series.length ? series[series.length - 1].day : opts.to,
    series,
    buckets,
    total: values.reduce((a, b) => a + b, 0),
    daysInRange: series.length,
    activeDays: active.length,
    perDay: describe(values),
    perActive: describe(active),
    perBucket: describe(buckets.map((b) => b.n)),
    streaks: streaks(series),
    weekday: byWeekday(series),
    peak,
  };
}

export const fmt = {
  int: (n) => Math.round(n).toLocaleString('pt-BR'),
  dec: (n, d = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }),
  /** 1.2 -> "1,2" mas 3 -> "3" (nao polui KPI com decimal zero) */
  num: (n, d = 1) => (Number.isInteger(n) ? fmt.int(n) : fmt.dec(n, d)),
  day: (day) => { const [y, m, d] = day.split('-'); return `${d}/${m}/${y}`; },
  dayShort: (day) => { const [, m, d] = day.split('-'); return `${d}/${m}`; },
  month: (key) => { const [y, m] = key.split('-'); return `${MONTH_LABELS[Number(m) - 1]}/${y.slice(2)}`; },
};

/** Rotulo do bucket conforme a granularidade. */
export function bucketLabel(bucket, granularity) {
  if (granularity === 'month') return fmt.month(bucket.key);
  if (granularity === 'week') return fmt.dayShort(bucket.start);
  return fmt.dayShort(bucket.key);
}

/** Nome da unidade do bucket, pra rotular as linhas de referencia sem ambiguidade. */
export function unitLabel(granularity) {
  return granularity === 'month' ? 'mês' : granularity === 'week' ? 'sem' : 'dia';
}
