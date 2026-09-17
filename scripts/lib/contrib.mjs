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

import { shiftDay, daysBetween, dayToMs, fmt } from './stats.mjs';
import {
  renderPanel, esc, r1, terminalChrome, promptLine, footerLine,
  BORDER_DEF, CHART_COLORS as C,
} from './svg.mjs';

const W = 820;
const PAD = 30;
const HEIGHT = 236;
const INNER = W - PAD * 2;

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

/** Uma coluna do painel: rotulo em cima, numero no meio, periodo embaixo. */
function column(cx, { label, value, note }) {
  return `
    <text x="${r1(cx)}" y="118" font-size="10.5" letter-spacing="0.6" fill="${C.inkDim}" text-anchor="middle">${esc(label)}</text>
    <text x="${r1(cx)}" y="163" font-size="30" font-weight="700" fill="${C.ink}" text-anchor="middle" style="font-variant-numeric:tabular-nums">${esc(value)}</text>
    <text x="${r1(cx)}" y="196" font-size="10" fill="${C.inkMuted}" text-anchor="middle">${esc(note)}</text>`;
}

/**
 * Anel: sequencia atual medida contra o RECORDE. O numero fica dentro e o
 * periodo embaixo, entao o anel e reforco — quem nao distingue a cor le o
 * mesmo dado no texto.
 */
function ring(cx, cy, r, value, target) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  // dash de comprimento zero com linecap round ainda desenha um ponto: so
  // arco quando ha sequencia.
  const arc = pct > 0
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.data}" stroke-width="6" stroke-linecap="round" pathLength="100" stroke-dasharray="${r1(pct)} ${r1(100 - pct)}" transform="rotate(-90 ${cx} ${cy})"/>`
    : '';
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.track}" stroke-width="6"/>
    ${arc}
    <text x="${cx}" y="${cy + 10}" font-size="27" font-weight="700" fill="${C.accent}" text-anchor="middle" style="font-variant-numeric:tabular-nums">${esc(fmt.int(value))}</text>`;
}

/** Painel de sequencia: total, sequencia atual (anel) e recorde. */
export function renderStreak(data) {
  const c = data.contributions;
  const s = streakOf(c);

  const cols = [PAD + INNER / 6, W / 2, W - PAD - INNER / 6];
  const sep = [PAD + INNER / 3, W - PAD - INNER / 3];

  const aria = `Sequência de contribuições: ${fmt.int(s.total)} contribuições desde ${fmt.day(c.firstDay)}, `
    + `sequência atual de ${fmt.int(s.current.len)} dias (${rangeLabel(s.current.start, s.current.end)}) `
    + `e recorde de ${fmt.int(s.longest.len)} dias (${rangeLabel(s.longest.start, s.longest.end)}).`;

  // A regra do "hoje nao quebra a sequencia" mora no <details> do README: nao
  // cabe aqui sem empurrar pra fora as notas que mudam a cada build.
  const footer = footerLine([
    'sequência = dias seguidos com ao menos uma contribuição',
    `${fmt.int(s.activeDays)} dias ativos`,
    `atualizado ${fmt.day(c.lastDay)}`,
  ], INNER);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HEIGHT}" width="${W}" height="${HEIGHT}" font-family="'JetBrains Mono','Fira Mono','Courier New',monospace" role="img" aria-label="${esc(aria)}">
  <defs>${BORDER_DEF}</defs>
  <!-- Sem animacao de entrada, mesma razao do painel de commits: e consumido
       como <img> no README, entao o dado tem que estar legivel no 1o frame. -->

  ${terminalChrome(W, HEIGHT, 'sequência')}

  ${promptLine(PAD, 76, 'gh api graphql --contributions | streak')}

  <line x1="${r1(sep[0])}" y1="104" x2="${r1(sep[0])}" y2="208" stroke="${C.grid}" stroke-width="1"/>
  <line x1="${r1(sep[1])}" y1="104" x2="${r1(sep[1])}" y2="208" stroke="${C.grid}" stroke-width="1"/>

  ${column(cols[0], {
    label: 'CONTRIBUIÇÕES',
    value: fmt.int(s.total),
    note: `desde ${fmt.day(c.firstDay)}`,
  })}

  <text x="${cols[1]}" y="118" font-size="10.5" letter-spacing="0.6" fill="${C.inkDim}" text-anchor="middle">SEQUÊNCIA ATUAL</text>
  ${ring(cols[1], 155, 31, s.current.len, s.longest.len)}
  <text x="${cols[1]}" y="196" font-size="10" fill="${C.inkMuted}" text-anchor="middle">${esc(rangeLabel(s.current.start, s.current.end))}</text>

  ${column(cols[2], {
    label: 'RECORDE',
    value: fmt.int(s.longest.len),
    note: rangeLabel(s.longest.start, s.longest.end),
  })}

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
