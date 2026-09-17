#!/usr/bin/env node
/**
 * build.mjs — le data/commits.json e gera:
 *   assets/commits-<preset>.svg   um painel por combinacao de filtro (o README
 *                                 nao roda JS, entao cada combinacao e um arquivo)
 *   assets/commits.svg            o painel padrao (90 dias, todos os dias)
 *   assets/streak.svg             sequencia de contribuicoes (total/atual/recorde)
 *   assets/activity.svg           contribuicoes do ultimo mes
 *   docs/commits.json             copia dos dados pro dashboard
 *   docs/stats.mjs                copia do modulo de estatistica pro dashboard
 *
 *   node scripts/build.mjs [caminho/para/commits.json]
 *
 * O argumento opcional serve pra renderizar a partir de um fixture (teste
 * visual) sem tocar em data/commits.json.
 */

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPanel } from './lib/svg.mjs';
import { renderStreak, renderActivity, ACTIVITY_DAYS } from './lib/contrib.mjs';
import { shiftDay, daysBetween, MONTH_LABELS } from './lib/stats.mjs';

/** '2026-05-01' -> 'mai/2026' (ano cheio: e titulo, nao rotulo de eixo). */
const monthYear = (day) => `${MONTH_LABELS[Number(day.slice(5, 7)) - 1]}/${day.slice(0, 4)}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => resolve(ROOT, ...parts);

/**
 * Os recortes oferecidos no README. Granularidade cresce com o intervalo pra
 * barra nenhuma virar fio de cabelo: 30/90 dias em barras diarias, 1 ano em
 * semanas, historico completo em meses.
 */
const PERIODS = [
  { id: '30d', title: 'últimos 30 dias', days: 30, granularity: 'day', since: '30.days' },
  { id: '90d', title: 'últimos 90 dias', days: 90, granularity: 'day', since: '90.days' },
  { id: '365d', title: 'últimos 12 meses', days: 365, granularity: 'week', since: '12.months' },
  { id: 'total', title: 'histórico completo', days: null, granularity: 'month', since: 'always' },
];

async function main() {
  const source = process.argv[2] ? resolve(process.argv[2]) : p('data/commits.json');
  const data = JSON.parse(await readFile(source, 'utf8'));
  await mkdir(p('assets'), { recursive: true });
  await mkdir(p('docs'), { recursive: true });

  const to = data.lastDay;
  const written = [];

  // Recorte ancorado (data.anchor): "desde quando eu passei a usar de verdade".
  // Sem ele, media e mediana do historico completo ficam diluidas pelos meses
  // em que o GitHub quase nao foi usado. Granularidade escolhida pelo tamanho
  // do intervalo, mesma regra dos presets fixos.
  const periods = [...PERIODS];
  if (data.anchor) {
    const span = daysBetween(data.anchor, to);
    periods.splice(3, 0, {
      id: 'desde',
      title: `desde ${monthYear(data.anchor)}`,
      days: null,
      from: data.anchor,
      granularity: span <= 92 ? 'day' : span <= 400 ? 'week' : 'month',
      since: data.anchor,
    });
  }

  for (const period of periods) {
    for (const businessOnly of [false, true]) {
      const preset = {
        ...period,
        businessOnly,
        from: period.from || (period.days ? shiftDay(to, -(period.days - 1)) : data.firstDay),
        to,
      };
      const id = `${period.id}${businessOnly ? '-uteis' : ''}`;
      const file = p(`assets/commits-${id}.svg`);
      await writeFile(file, renderPanel(data, preset), 'utf8');
      written.push(`assets/commits-${id}.svg`);
    }
  }

  // Painel padrao do README — nome estavel. Prefere o recorte ancorado em dias
  // uteis: e a leitura que descreve o ritmo real de trabalho.
  const fallback = data.anchor ? 'commits-desde-uteis.svg' : 'commits-90d.svg';
  await copyFile(p(`assets/${fallback}`), p('assets/commits.svg'));

  // Sequencia e atividade: mesmo calendario que o GitHub mostra no quadro
  // verde. Renderizados aqui porque os servicos de terceiro que faziam isso
  // (streak-stats e github-readme-activity-graph) caem — ver lib/contrib.mjs.
  // Sem o bloco no JSON os paineis nao sao regravados: melhor manter o SVG
  // antigo no lugar do que publicar um painel zerado.
  if (data.contributions) {
    await writeFile(p('assets/streak.svg'), renderStreak(data), 'utf8');
    await writeFile(p('assets/activity.svg'), renderActivity(data), 'utf8');
    written.push('assets/streak.svg', 'assets/activity.svg');
  } else {
    console.warn('AVISO: data/commits.json sem `contributions` — rode scripts/collect.mjs de novo.');
  }

  await copyFile(source, p('docs/commits.json'));
  await copyFile(p('scripts/lib/stats.mjs'), p('docs/stats.mjs'));

  console.log(`> ${written.length} paineis + assets/commits.svg`);
  if (data.contributions) {
    console.log(`> streak + atividade (${ACTIVITY_DAYS}d) de ${data.contributions.total} contribuicoes`);
  }
  console.log(`> docs/commits.json e docs/stats.mjs sincronizados`);
  console.log(`> ${data.totalCommits} commits · escopo ${data.scope} · gerado ${data.generatedAt}`);
}

main().catch((err) => {
  console.error(`FALHOU: ${err.message}`);
  process.exit(1);
});
