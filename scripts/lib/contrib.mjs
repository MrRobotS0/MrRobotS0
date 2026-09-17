/**
 * contrib.mjs — painel de sequencia (streak) e grafico de atividade, a partir
 * do calendario de contribuicoes do GitHub (data.contributions).
 *
 * Por que existe: estes dois paineis vinham de servicos de terceiro —
 * streak-stats.demolab.com e github-readme-activity-graph.vercel.app. O
 * primeiro e uma instancia publica compartilhada que estoura o rate limit da
 * API e devolve "Failed to retrieve contributions" (e o camo do GitHub cacheia
 * o erro por horas); o segundo teve o deploy desativado e passou a responder
 * 402. Renderizando aqui, no mesmo job que ja tem o STATS_TOKEN, nao ha
 * terceiro pra cair.
 *
 * "Contribuicao" aqui e o que o GitHub conta no quadro verde do perfil: commit,
 * PR, issue e review. Nao e a mesma serie do painel de commits (que le o
 * historico de cada repo) — por isso os numeros diferem, e de proposito.
 */

import { shiftDay, daysBetween, dayToMs, fmt, MONTH_LABELS } from './stats.mjs';
import {
  renderPanel, esc, r1, kpi, textW, terminalChrome, promptLine, footerLine,
  BORDER_DEF, CHART_COLORS as C,
} from './svg.mjs';

const W = 820;
const PAD = 30;
const HEIGHT = 300;
const INNER = W - PAD * 2;

/** Quantos dias a fita de sequencia mostra. */
const STRIP_DAYS = 90;

/** Quantos dias o grafico de atividade cobre (o recorte "ultimo mes"). */
export const ACTIVITY_DAYS = 31;

/**
 * Adapta o calendario pro formato que renderPanel/stats esperam
 * (`days[dia] = { n, r }`), pra atividade e commits passarem pela MESMA
 * estatistica em vez de cada um ter a sua.
 */
export function contributionData(data) {
  const c = data.contributions;
  const days = Object.create(null);
  for (const day of Object.keys(c.days)) days[day] = { n: c.days[day], r: {} };
  return {
    ...data,
    firstDay: c.firstDay,
    lastDay: c.lastDay,
    totalCommits: c.total,
    days,
  };
}

/** Dia seguinte ao dia ativo anterior? (so dias ativos vao pro JSON) */
const isNext = (prev, day) => dayToMs(day) - dayToMs(prev) === 86400000;

/**
 * Sequencias sobre o calendario.
 *
 * O dia de HOJE nao quebra a sequencia: ele ainda pode receber contribuicao
 * antes de virar. Sem essa regra o painel mostraria 0 toda manha — e o quadro
 * verde do GitHub tambem nao faz isso.
 */
export function streakOf(contributions) {
  const active = Object.keys(contributions.days).sort();
  const has = (day) => Boolean(contributions.days[day]);

  let longest = { len: 0, start: null, end: null };
  let runStart = null;
  active.forEach((day, i) => {
    const prev = active[i - 1];
    if (!prev || !isNext(prev, day)) runStart = day;
    const len = daysBetween(runStart, day);
    if (len > longest.len) longest = { len, start: runStart, end: day };
  });

  let end = contributions.lastDay;
  if (!has(end)) end = shiftDay(end, -1); // hoje ainda esta aberto
  let current = { len: 0, start: null, end: null };
  if (has(end)) {
    let start = end;
    while (has(shiftDay(start, -1))) start = shiftDay(start, -1);
    current = { len: daysBetween(start, end), start, end };
  }

  return { total: contributions.total, activeDays: active.length, current, longest };
}

/** '2026-05-11'..'2026-05-15' -> '11/05 — 15/05/2026' (ano so uma vez). */
function rangeLabel(start, end) {
  if (!start || !end) return 'nenhuma ainda';
  if (start === end) return fmt.day(start);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${sameYear ? fmt.dayShort(start) : fmt.day(start)} — ${fmt.day(end)}`;
}

/**
 * Fita dos ultimos 90 dias: um retangulo por dia, aceso se teve contribuicao.
 *
 * BINARIO de proposito. Intensidade e a pergunta do painel de atividade, que
 * fica logo acima; aqui a pergunta e a SEQUENCIA, e pintar 5 tons de verde so
 * atrapalharia enxergar onde uma corrida comeca e termina. Como efeito
 * colateral a fita explica o recorde: as corridas morrem no fim de semana, e e
 * por isso que 5 (seg a sex) e o teto.
 */
function strip(contributions, current, top) {
  const to = contributions.lastDay;
  const from = shiftDay(to, -(STRIP_DAYS - 1));
  const step = INNER / STRIP_DAYS;
  const cellW = r1(step - 1.6);
  const cellH = 14;

  let cells = '';
  let months = '';
  for (let i = 0; i < STRIP_DAYS; i += 1) {
    const day = shiftDay(from, i);
    const x = r1(PAD + i * step);
    const on = Boolean(contributions.days[day]);
    cells += `<rect x="${x}" y="${top}" width="${cellW}" height="${cellH}" rx="2" fill="${on ? C.data : C.grid}"/>`;
    // Rotulo de mes na primeira celula e em todo dia 1 — mesma ancoragem do
    // quadro de contribuicoes do GitHub, que e onde o olho ja procura.
    if (i === 0 || day.slice(8) === '01') {
      months += `<text x="${x}" y="${top - 8}" font-size="10" fill="${C.inkMuted}">${MONTH_LABELS[Number(day.slice(5, 7)) - 1]}</text>`;
    }
  }

  // Sublinhado na corrida atual: o "voce esta aqui" da fita. Fica a ESQUERDA
  // porque a corrida atual termina em hoje, colada na borda direita.
  let mark = '';
  if (current.len) {
    const last = daysBetween(from, current.end) - 1;
    const first = Math.max(0, daysBetween(from, current.start) - 1);
    if (last >= 0) {
      const x0 = PAD + first * step;
      const x1 = PAD + last * step + cellW;
      const y = top + cellH + 8;
      const label = 'sequência atual';
      mark = `<line x1="${r1(x0)}" y1="${y}" x2="${r1(x1)}" y2="${y}" stroke="${C.accent}" stroke-width="2" stroke-linecap="round"/>
    <text x="${r1(x0 - 8)}" y="${y + 4}" font-size="10" fill="${C.inkDim}" text-anchor="end">${esc(label)}</text>`;
    }
  }

  return { cells, months, mark };
}

/** Legenda da fita: quadradinho + texto, pro verde nao ser a unica pista. */
function swatch(x, y, color, text) {
  return `<rect x="${r1(x)}" y="${r1(y - 8.5)}" width="9" height="9" rx="2" fill="${color}"/>
    <text x="${r1(x + 15)}" y="${y}" font-size="10.5" fill="${C.inkDim}">${esc(text)}</text>`;
}

/**
 * Painel de sequencia. Mesma estrutura do painel de atividade — fila de tiles
 * a esquerda, um heroi, divisor, e o desenho ocupando a largura inteira —
 * porque os dois ficam um embaixo do outro e precisam ler como o mesmo
 * terminal, nao como dois widgets de origens diferentes.
 */
export function renderStreak(data) {
  const c = data.contributions;
  const s = streakOf(c);

  const tiles = [
    {
      label: 'SEQUÊNCIA ATUAL',
      value: fmt.int(s.current.len),
      note: rangeLabel(s.current.start, s.current.end),
      hero: true,
    },
    { label: 'RECORDE', value: fmt.int(s.longest.len), note: rangeLabel(s.longest.start, s.longest.end) },
    { label: 'CONTRIBUIÇÕES', value: fmt.int(s.total), note: `desde ${fmt.day(c.firstDay)}` },
    { label: 'DIAS ATIVOS', value: fmt.int(s.activeDays), note: 'com ≥1 contribuição' },
  ];
  const tileW = INNER / tiles.length;
  const kpis = tiles.map((t, i) => kpi(PAD + i * tileW, 108, tileW, t)).join('');

  const fita = strip(c, s.current, 228);

  // Legenda alinhada a direita, no mesmo lugar em que o painel de atividade
  // poe as chaves de media e mediana. Uma entrada so: a celula apagada e
  // escura demais pra virar amostra legivel, e "sem contribuicao" e o que
  // sobra — nao precisa de swatch pra ser entendido.
  const comX = W - PAD - (15 + textW('dia com contribuição', 10.5));

  const aria = `Sequência de contribuições: sequência atual de ${fmt.int(s.current.len)} dias `
    + `(${rangeLabel(s.current.start, s.current.end)}), recorde de ${fmt.int(s.longest.len)} dias `
    + `(${rangeLabel(s.longest.start, s.longest.end)}), ${fmt.int(s.total)} contribuições desde ${fmt.day(c.firstDay)} `
    + `em ${fmt.int(s.activeDays)} dias ativos. Abaixo, os últimos ${STRIP_DAYS} dias, um por dia, acesos nos dias com contribuição.`;

  const footer = footerLine([
    'sequência = dias seguidos com ao menos uma contribuição',
    'hoje só quebra quando o dia termina',
    `atualizado ${fmt.day(c.lastDay)}`,
  ], INNER);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HEIGHT}" width="${W}" height="${HEIGHT}" font-family="'JetBrains Mono','Fira Mono','Courier New',monospace" role="img" aria-label="${esc(aria)}">
  <defs>${BORDER_DEF}</defs>
  <!-- Sem animacao de entrada, mesma razao do painel de commits: e consumido
       como <img> no README, entao o dado tem que estar legivel no 1o frame. -->

  ${terminalChrome(W, HEIGHT, 'sequência')}

  ${promptLine(PAD, 76, 'gh api graphql --contributions | streak')}

  ${kpis}

  <line x1="${PAD}" y1="188" x2="${W - PAD}" y2="188" stroke="${C.grid}" stroke-width="1"/>
  <text x="${PAD}" y="206" font-size="11" fill="${C.inkDim}">últimos ${STRIP_DAYS} dias</text>
  ${swatch(comX, 206, C.data, 'dia com contribuição')}

  <g>${fita.months}</g>
  <g>${fita.cells}</g>
  ${fita.mark}

  <text x="${PAD}" y="${HEIGHT - 18}" font-size="10" fill="${C.inkMuted}">${esc(footer)}</text>
</svg>
`;
}

/**
 * Grafico de atividade do ultimo mes. Area, nao barra: aqui a pergunta e o
 * RITMO ao longo do mes — o painel de commits ja cobre a leitura dia a dia em
 * barras, e repetir a mesma forma duas vezes na pagina nao acrescenta nada.
 */
export function renderActivity(data, days = ACTIVITY_DAYS) {
  const c = contributionData(data);
  return renderPanel(c, {
    id: 'atividade',
    title: `últimos ${days} dias`,
    since: `${days}.days`,
    from: shiftDay(c.lastDay, -(days - 1)),
    to: c.lastDay,
    granularity: 'day',
    businessOnly: false,
    metric: 'contributions',
    shape: 'area',
  });
}
