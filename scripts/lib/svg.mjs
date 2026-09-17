/**
 * svg.mjs — desenha o painel "serie x tempo" como SVG estatico.
 *
 * O README do GitHub e sanitizado (nada de <script>), entao a interatividade
 * mora no dashboard e aqui entra um SVG por combinacao de filtro. Mesmo modulo
 * de estatistica do dashboard (lib/stats.mjs) -> os numeros nunca divergem.
 *
 * O MESMO desenho serve a duas series diferentes (preset.metric):
 *   commits        historico de cada repo, so branch padrao
 *   contributions  calendario do GitHub (commits + PRs + issues + reviews)
 * Trocar so o vocabulario evita dois renderizadores divergindo com o tempo.
 *
 * Paleta validada com o validador do skill dataviz (superficie #0D1117):
 *   #22C55E commits · #38BDF8 media · #F472B6 mediana
 *   chroma OK · CVD adjacente dE 10.4 (>=8) · piso visao normal 22.5 · contraste >=3:1
 * Contraste dos textos medido sobre a superficie efetiva, com o medidor
 * calibrado (#000/#fff = 21,00 e #767676/#fff = 4,54):
 *   #C9D1D9 12,3 · #22C55E 8,3 · #8B949E 6,2 (5,6 sobre a barra #161B22) · #7B838D 4,9
 *   (a faixa de lightness do validador e calibrada pra superficie #1a1a19; a
 *   nossa e mais escura e essas sao as cores de marca do perfil — desvio ciente)
 */

import { analyze, bucketLabel, unitLabel, fmt, WEEKDAY_LABELS } from './stats.mjs';

const C = {
  surface: '#0D1117',
  bar: '#161B22',
  grid: '#1F2630',
  ink: '#C9D1D9',
  inkDim: '#8B949E',
  // 4,93:1 sobre a superficie. Era #6E7681, que da 4,12:1 e reprovava os 4,5:1
  // de corpo — e este cinza carrega as notas, o rodape e os rotulos de eixo,
  // que sao texto de 10px, o pior lugar pra economizar contraste.
  inkMuted: '#7B838D',
  data: '#22C55E',
  dataSoft: '#064E3B',
  // Trilho do anel de sequencia. Nao da pra ter 3:1 nos DOIS lados: o verde tem
  // 8,3:1 sobre a superficie, e empilhar 3:1 de cada lado exigiria 9:1. Entao
  // ganha o lado que carrega o dado — arco contra trilho fica em 3,5:1, pra
  // enxergar ONDE o arco termina; o trilho em si e so a volta completa, e o
  // numero dentro do anel ja diz o valor sem depender de cor nenhuma.
  track: '#33574A',
  mean: '#38BDF8',
  median: '#F472B6',
  accent: '#22C55E',
};

const W = 820;
const PAD = 30;
const PLOT = { left: 70, right: W - PAD, top: 224, height: 132 };
const HEIGHT = 424;

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const r1 = (n) => Math.round(n * 10) / 10;

/** Gradiente da borda. Vive em <defs> com id fixo — cada painel e um arquivo. */
export const BORDER_DEF = `<linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22C55E" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#064E3B" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#22C55E" stop-opacity="0.15"/>
    </linearGradient>`;

/**
 * Moldura de terminal: fundo, borda em gradiente, barra de titulo com os tres
 * pontos. E o que faz painel de commits, de streak e de atividade lerem como
 * janelas do MESMO terminal em vez de tres widgets avulsos.
 */
export function terminalChrome(width, height, title) {
  return `<rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="14" fill="${C.surface}"/>
  <rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="14" fill="none" stroke="url(#border)" stroke-width="1.5"/>
  <path d="M1.5 15.5 A14 14 0 0 1 15.5 1.5 H${width - 15.5} A14 14 0 0 1 ${width - 1.5} 15.5 V46 H1.5 Z" fill="${C.bar}"/>
  <line x1="1.5" y1="46" x2="${width - 1.5}" y2="46" stroke="#22C55E" stroke-opacity="0.18" stroke-width="1"/>
  <circle cx="28" cy="24" r="6" fill="#FF5F56"/><circle cx="50" cy="24" r="6" fill="#FFBD2E"/><circle cx="72" cy="24" r="6" fill="#27C93F"/>
  <text x="${width / 2}" y="29" font-size="13" fill="${C.inkDim}" text-anchor="middle">guilherme@fsociety: ~/stats — ${esc(title)}</text>`;
}

/** A linha de prompt logo abaixo da barra de titulo. */
export function promptLine(x, y, command) {
  return `<text x="${x}" y="${y}" font-size="12.5">
    <tspan fill="${C.accent}" font-weight="700">guilherme@fsociety</tspan><tspan fill="${C.inkMuted}">:~$</tspan><tspan fill="${C.ink}"> ${esc(command)}</tspan>
  </text>`;
}

/** Passo "redondo" pro eixo Y: 1,2,5,10,20,50... com ~4 marcas. */
function niceScale(max, ticks = 4) {
  if (max <= 0) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 3, 4, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** Barra com topo arredondado (4px) e base reta na linha zero. */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, h);
  if (rr <= 0.5) return `M${r1(x)} ${r1(y + h)}h${r1(w)}v${r1(-h)}h${r1(-w)}Z`;
  return `M${r1(x)} ${r1(y + h)}V${r1(y + rr)}a${r1(rr)} ${r1(rr)} 0 0 1 ${r1(rr)} ${r1(-rr)}` +
    `h${r1(w - 2 * rr)}a${r1(rr)} ${r1(rr)} 0 0 1 ${r1(rr)} ${r1(rr)}V${r1(y + h)}Z`;
}

/**
 * Um tile de KPI. `hero` só no primeiro (o total) — uma figura heroi por vista.
 */
export function kpi(x, y, wTile, { label, value, note, hero }) {
  const size = hero ? 27 : 20;
  return `
    <text x="${r1(x)}" y="${y}" font-size="10.5" letter-spacing="0.6" fill="${C.inkDim}">${esc(label)}</text>
    <text x="${r1(x)}" y="${y + 27}" font-size="${size}" font-weight="700" fill="${hero ? C.accent : C.ink}">${esc(value)}</text>
    ${note ? `<text x="${r1(x)}" y="${y + 43}" font-size="10" fill="${C.inkMuted}">${esc(note)}</text>` : ''}`;
}

/**
 * Chave de uma linha de referencia, desenhada no cabecalho do grafico.
 *
 * Ficava dentro do plot antes, colada na propria linha — e quando a media cai
 * perto do zero (caso comum: mediana 1) o rotulo sentava em cima do eixo X.
 * No cabecalho nunca colide, e o tracinho repete o MESMO dash da linha, entao a
 * identidade vem do desenho, nao de texto colorido (ciano/rosa como texto no
 * #0D1117 e ilegivel).
 */
function refKey(x, y, color, dash, text) {
  return `
    <line x1="${r1(x)}" y1="${r1(y - 3.5)}" x2="${r1(x + 18)}" y2="${r1(y - 3.5)}" stroke="${color}" stroke-width="2" stroke-dasharray="${dash}"/>
    <text x="${r1(x + 24)}" y="${y}" font-size="10.5" fill="${C.inkDim}">${esc(text)}</text>`;
}

/** Largura aproximada de texto em JetBrains Mono (avanco ~0.6em). */
export const textW = (text, size) => text.length * size * 0.6;

/**
 * Junta as notas do rodape ate onde cabe na largura util.
 *
 * O SVG tem viewBox fixo: rodape comprido nao quebra linha, ele simplesmente
 * sai pela borda e aparece cortado no meio de uma palavra. Como as notas ja
 * vem em ordem de importancia, derrubar a ultima e melhor do que exibir meia
 * palavra — e a primeira nota sempre entra, mesmo que sozinha ela estoure.
 */
export function footerLine(parts, maxWidth, size = 10) {
  const kept = [];
  for (const part of parts.filter(Boolean)) {
    if (kept.length && textW([...kept, part].join('  ·  '), size) > maxWidth) break;
    kept.push(part);
  }
  return kept.join('  ·  ');
}

/** Linha de comando que descreve o filtro — o "filtro" visivel do painel. */
function commandLine(preset, weekdaysLabel) {
  const parts = [`--since=${preset.since}`];
  if (preset.granularity !== 'day') parts.push(`--group=${preset.granularity === 'week' ? 'week' : 'month'}`);
  if (weekdaysLabel) parts.push('--weekdays=mon-fri');
  return `git log ${parts.join(' ')} | stats`;
}

/**
 * Vocabulario por metrica. So texto: o desenho, a escala e a estatistica sao
 * identicos — e por isso que os dois paineis nunca contam a mesma coisa de
 * dois jeitos.
 *
 * `scopeNote` difere de proposito. O historico de commits so enxerga o que o
 * token alcanca; o calendario do GitHub ja soma o que e privado, mas so o
 * numero — nunca o repositorio. Dizer isso e o que mantem o painel honesto.
 */
export const METRICS = {
  commits: {
    kpi: 'COMMITS',
    plural: 'commits',
    cap: 'Commits',
    empty: 'sem commits nesse filtro',
    command: commandLine,
    scopeNote: (data) => (data.scope === 'all'
      ? 'públicos + privados'
      : `só públicos${data.hiddenRestrictedContributions ? ` · ${fmt.int(data.hiddenRestrictedContributions)} privados fora` : ''}`),
  },
  contributions: {
    kpi: 'CONTRIBUIÇÕES',
    plural: 'contribuições',
    cap: 'Contribuições',
    empty: 'sem contribuições nesse período',
    command: (preset) => `gh api graphql --contributions --since=${preset.since} | stats`,
    scopeNote: () => 'commits + PRs + issues + reviews',
  },
};

/**
 * Renderiza o painel.
 * @param {object} data   data/commits.json
 * @param {object} preset { id, title, since, from, to, granularity, businessOnly }
 */
export function renderPanel(data, preset) {
  const metric = METRICS[preset.metric] || METRICS.commits;
  const weekdays = preset.businessOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  const a = analyze(data, {
    from: preset.from, to: preset.to, granularity: preset.granularity, weekdays,
  });

  const unit = preset.businessOnly ? 'dia útil' : 'dia';
  const unitPlural = preset.businessOnly ? 'dias úteis' : 'dias';
  const bucketUnit = unitLabel(a.granularity);
  const bucketName = bucketUnit === 'sem' ? 'semana' : bucketUnit;
  const buckets = a.buckets;
  // Barra le bem dia a dia; area le melhor como TENDENCIA. Acima de 92 buckets
  // a barra vira fio de cabelo e a area e obrigatoria, mas preset.shape deixa
  // escolher antes disso — e o que distingue "contribuicoes ao longo do mes"
  // (ritmo) de "commits por dia" (contagem).
  const asBars = preset.shape ? preset.shape === 'bars' : buckets.length <= 92;

  const scale = niceScale(Math.max(a.perBucket.max, 1));
  const plotW = PLOT.right - PLOT.left;
  const yOf = (v) => PLOT.top + PLOT.height - (v / scale.max) * PLOT.height;
  const baseline = PLOT.top + PLOT.height;

  // ── grid + eixo Y ────────────────────────────────────────────────────────
  let grid = '';
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = yOf(v);
    grid += `<line x1="${PLOT.left}" y1="${r1(y)}" x2="${PLOT.right}" y2="${r1(y)}" stroke="${v === 0 ? C.inkMuted : C.grid}" stroke-width="1" ${v === 0 ? 'stroke-opacity="0.5"' : ''}/>`;
    grid += `<text x="${PLOT.left - 10}" y="${r1(y + 3.5)}" font-size="10" fill="${C.inkMuted}" text-anchor="end" style="font-variant-numeric:tabular-nums">${fmt.int(v)}</text>`;
  }

  // ── marcas ───────────────────────────────────────────────────────────────
  let marks = '';
  const band = plotW / Math.max(buckets.length, 1);
  if (buckets.length === 0 || a.total === 0) {
    marks = `<text x="${PLOT.left + plotW / 2}" y="${r1(PLOT.top + PLOT.height / 2)}" font-size="12" fill="${C.inkDim}" text-anchor="middle">${esc(metric.empty)}</text>`;
  } else if (asBars) {
    const barW = Math.min(24, Math.max(2, band - 2)); // 2px de respiro entre vizinhas
    buckets.forEach((b, i) => {
      if (!b.n) return;
      const h = Math.max(2, baseline - yOf(b.n)); // 1 commit tem que aparecer
      const x = PLOT.left + i * band + (band - barW) / 2;
      marks += `<path d="${barPath(x, baseline - h, barW, h)}" fill="${C.data}"/>`;
    });
  } else {
    const pts = buckets.map((b, i) => [PLOT.left + i * band + band / 2, yOf(b.n)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');
    marks += `<path d="${line}L${r1(pts[pts.length - 1][0])} ${baseline}L${r1(pts[0][0])} ${baseline}Z" fill="${C.data}" fill-opacity="0.1"/>`;
    marks += `<path d="${line}" fill="none" stroke="${C.data}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const [lx, ly] = pts[pts.length - 1];
    marks += `<circle cx="${r1(lx)}" cy="${r1(ly)}" r="4" fill="${C.data}" stroke="${C.surface}" stroke-width="2"/>`;
  }

  // ── linhas de referencia (media / mediana do bucket) ─────────────────────
  const MEAN_DASH = '6 4';
  const MEDIAN_DASH = '2 3';
  let refs = '';
  let keys = '';
  if (a.total > 0) {
    const meanY = yOf(a.perBucket.mean);
    const medY = yOf(a.perBucket.median);
    refs += `<line x1="${PLOT.left}" y1="${r1(meanY)}" x2="${PLOT.right}" y2="${r1(meanY)}" stroke="${C.mean}" stroke-width="1.5" stroke-dasharray="${MEAN_DASH}"/>`;
    refs += `<line x1="${PLOT.left}" y1="${r1(medY)}" x2="${PLOT.right}" y2="${r1(medY)}" stroke="${C.median}" stroke-width="1.5" stroke-dasharray="${MEDIAN_DASH}"/>`;

    // chaves alinhadas a direita do cabecalho do grafico
    const meanText = `média/${bucketUnit} ${fmt.num(a.perBucket.mean)}`;
    const medText = `mediana/${bucketUnit} ${fmt.num(a.perBucket.median)}`;
    const medX = PLOT.right - (24 + textW(medText, 10.5));
    const meanX = medX - 22 - (24 + textW(meanText, 10.5));
    keys += refKey(meanX, 208, C.mean, MEAN_DASH, meanText);
    keys += refKey(medX, 208, C.median, MEDIAN_DASH, medText);
  }

  // ── eixo X ───────────────────────────────────────────────────────────────
  let xAxis = '';
  const every = Math.max(1, Math.ceil(buckets.length / 8));
  buckets.forEach((b, i) => {
    if (i % every || i > buckets.length - 1) return;
    const x = PLOT.left + i * band + band / 2;
    if (x > PLOT.right - 18) return; // nao deixa colidir com a borda direita
    xAxis += `<text x="${r1(x)}" y="${baseline + 18}" font-size="10" fill="${C.inkMuted}" text-anchor="middle">${esc(bucketLabel(b, a.granularity))}</text>`;
  });

  // ── KPIs ─────────────────────────────────────────────────────────────────
  // Rotulos e notas ficam curtos de proposito: cada tile tem ~152px e a fonte e
  // monoespacada, entao texto longo nao "aperta" — ele vaza pro tile vizinho.
  const activePct = a.daysInRange ? Math.round((a.activeDays / a.daysInRange) * 100) : 0;
  const tiles = [
    { label: metric.kpi, value: fmt.int(a.total), note: `em ${fmt.int(a.daysInRange)} ${unitPlural}`, hero: true },
    { label: `MÉDIA/${unit.toUpperCase()}`, value: fmt.num(a.perDay.mean), note: `ativos: ${fmt.num(a.perActive.mean)}` },
    { label: `MEDIANA/${unit.toUpperCase()}`, value: fmt.num(a.perDay.median), note: `ativos: ${fmt.num(a.perActive.median)}` },
    { label: 'PICO EM UM DIA', value: a.peak ? fmt.int(a.peak.n) : '0', note: a.peak && a.peak.n ? fmt.day(a.peak.day) : '—' },
    { label: 'DIAS ATIVOS', value: `${fmt.int(a.activeDays)}`, note: `${activePct}% · streak ${fmt.int(a.streaks.current)}` },
  ];
  const tileW = (PLOT.right - PAD) / tiles.length;
  const kpis = tiles.map((t, i) => kpi(PAD + i * tileW, 108, tileW, t)).join('');

  // ── chrome + rodape ──────────────────────────────────────────────────────
  const scopeNote = metric.scopeNote(data);
  const footer = footerLine([
    preset.businessOnly ? 'dias úteis (seg–sex)' : 'todos os dias',
    `agrupado por ${bucketName}`,
    scopeNote,
    `melhor sequência ${fmt.int(a.streaks.longest)}`,
    `atualizado ${fmt.day(data.lastDay)}`,
  ], PLOT.right - PAD);

  const title = `${preset.title}${preset.businessOnly ? ' · dias úteis' : ''}`;
  const aria = `${metric.cap} por ${bucketName} — ${preset.title}${preset.businessOnly ? ', apenas dias úteis' : ''}: `
    + `${fmt.int(a.total)} ${metric.plural} em ${fmt.int(a.daysInRange)} ${unitPlural}, média ${fmt.num(a.perDay.mean)} e mediana ${fmt.num(a.perDay.median)} por ${unit}, `
    + `pico de ${a.peak ? fmt.int(a.peak.n) : 0} ${metric.plural}${a.peak && a.peak.n ? ` em ${fmt.day(a.peak.day)}` : ''}, `
    + `${fmt.int(a.activeDays)} dias ativos (${activePct}%), streak atual ${fmt.int(a.streaks.current)} e recorde ${fmt.int(a.streaks.longest)}.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HEIGHT}" width="${W}" height="${HEIGHT}" font-family="'JetBrains Mono','Fira Mono','Courier New',monospace" role="img" aria-label="${esc(aria)}">
  <defs>
    ${BORDER_DEF}
    <clipPath id="plotclip"><rect x="${PLOT.left - 1}" y="${PLOT.top - 24}" width="${plotW + 2}" height="${PLOT.height + 26}"/></clipPath>
  </defs>
  <!-- Sem animacao de entrada de proposito: este SVG e consumido como <img> no
       README, onde um wipe por clip-path CSS pode nunca resolver e deixar o
       grafico VAZIO. Dado tem que ser legivel no primeiro frame. -->

  ${terminalChrome(W, HEIGHT, title)}

  ${promptLine(PAD, 76, metric.command(preset, preset.businessOnly))}

  ${kpis}

  <line x1="${PAD}" y1="188" x2="${PLOT.right}" y2="188" stroke="${C.grid}" stroke-width="1"/>
  <text x="${PAD}" y="208" font-size="11" fill="${C.inkDim}">${esc(metric.plural)} por ${bucketName}</text>
  ${keys}

  <g>${grid}</g>
  <g clip-path="url(#plotclip)">${marks}</g>
  <g>${refs}</g>
  <g>${xAxis}</g>

  <text x="${PAD}" y="${HEIGHT - 18}" font-size="10" fill="${C.inkMuted}">${esc(footer)}</text>
</svg>
`;
}

export { C as CHART_COLORS, WEEKDAY_LABELS };
