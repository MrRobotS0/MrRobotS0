#!/usr/bin/env node
/**
 * collect.mjs — coleta o historico de commits (publicos + privados) via GraphQL
 * e grava `data/commits.json`.
 *
 *   node scripts/collect.mjs
 *
 * Token (em ordem de preferencia):
 *   STATS_TOKEN  — PAT classico com escopo `repo`. Necessario pra ver PRIVADOS.
 *   GITHUB_TOKEN — token do Action. So enxerga repos publicos; o script avisa e
 *                  segue, marcando scope:"public" no JSON pra UI ser honesta.
 *
 * Config por env:
 *   STATS_USER            login (default: MrRobotS0)
 *   STATS_TZ              fuso pra bucketizar o dia (default: America/Sao_Paulo)
 *   STATS_REVEAL_PRIVATE  "true" mostra o nome real dos repos privados no JSON.
 *                         Default false: o JSON vive num repo publico, entao
 *                         privado entra como "privado #1" — a contagem conta,
 *                         o nome nao vaza.
 *   STATS_ANCHOR          'YYYY-MM-DD' de quando a atividade "de verdade"
 *                         comecou (default 2026-05-01). Vira um recorte proprio
 *                         no README e um preset no dashboard, pra media e
 *                         mediana nao serem diluidas pelo periodo em que o
 *                         GitHub quase nao era usado.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/commits.json');

const TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
const USER = process.env.STATS_USER || 'MrRobotS0';
const TZ = process.env.STATS_TZ || 'America/Sao_Paulo';
const REVEAL_PRIVATE = process.env.STATS_REVEAL_PRIVATE === 'true';
const ANCHOR = process.env.STATS_ANCHOR || '2026-05-01';
const HAS_PAT = Boolean(process.env.STATS_TOKEN);

if (!TOKEN) {
  console.error('ERRO: defina STATS_TOKEN (PAT com escopo repo) ou GITHUB_TOKEN.');
  process.exit(1);
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
/** ISO instant -> 'YYYY-MM-DD' no fuso configurado. */
const localDay = (iso) => dayFmt.format(new Date(iso));

let calls = 0;

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mrrobots0-commit-stats',
      },
      body: JSON.stringify({ query, variables }),
    });
    calls += 1;

    // Secondary rate limit / instabilidade: recua e tenta de novo.
    if ((res.status === 403 || res.status === 502 || res.status === 429) && attempt <= 4) {
      const wait = 2 ** attempt * 1000;
      console.warn(`  HTTP ${res.status} — retry em ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);

    const body = await res.json();
    if (body.errors) {
      const msg = body.errors.map((e) => e.message).join(' | ');
      // NOT_FOUND/FORBIDDEN de um repo especifico nao derruba a coleta.
      const soft = body.errors.every((e) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.type));
      if (soft) return body.data;
      throw new Error(`GraphQL: ${msg}`);
    }
    return body.data;
  }
}

const Q_USER = `
  query($login: String!) {
    user(login: $login) { id login name createdAt }
  }`;

const Q_REPOS = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        restrictedContributionsCount
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { nameWithOwner owner { login } name isPrivate isFork }
        }
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

const Q_HISTORY = `
  query($owner: String!, $name: String!, $authorId: ID!, $since: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(author: { id: $authorId }, since: $since, first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { oid committedDate }
            }
          }
        }
      }
    }
  }`;

/** Janelas de 1 ano: contributionsCollection nao aceita intervalo maior. */
function yearWindows(fromISO, toISO) {
  const windows = [];
  let start = new Date(fromISO);
  const end = new Date(toISO);
  while (start < end) {
    const next = new Date(start);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    windows.push([start.toISOString(), (next < end ? next : end).toISOString()]);
    start = next;
  }
  return windows;
}

async function main() {
  console.log(`> coletando commits de ${USER} (fuso ${TZ})`);
  console.log(`> token: ${HAS_PAT ? 'STATS_TOKEN (publicos + privados)' : 'GITHUB_TOKEN (SO PUBLICOS)'}`);

  const { user } = await gql(Q_USER, { login: USER });
  if (!user) throw new Error(`usuario ${USER} nao encontrado`);

  const nowISO = new Date().toISOString();
  const windows = yearWindows(user.createdAt, nowISO);

  /** nameWithOwner -> { owner, name, isPrivate, contributed } */
  const repos = new Map();
  /** 'YYYY-MM-DD' -> contribuicoes do dia (commits + PRs + issues + reviews) */
  const calendar = Object.create(null);
  let restricted = 0;

  for (const [from, to] of windows) {
    const data = await gql(Q_REPOS, { login: USER, from, to });
    const c = data.user.contributionsCollection;
    restricted += c.restrictedContributionsCount || 0;
    for (const item of c.commitContributionsByRepository) {
      const r = item.repository;
      if (!r) continue;
      const prev = repos.get(r.nameWithOwner);
      repos.set(r.nameWithOwner, {
        owner: r.owner.login,
        name: r.name,
        isPrivate: r.isPrivate,
        isFork: r.isFork,
        contributed: (prev ? prev.contributed : 0) + item.contributions.totalCount,
      });
    }
    // O calendario vem em SEMANAS CHEIAS, entao janelas anuais vizinhas se
    // sobrepoem nas bordas. A chave e a data: reescrever o mesmo dia com o
    // mesmo valor e inocuo, e somar seria contar duas vezes.
    for (const week of c.contributionCalendar.weeks) {
      for (const d of week.contributionDays) calendar[d.date] = d.contributionCount;
    }
  }
  console.log(`> ${repos.size} repositorios com commits seus (${windows.length} janelas anuais)`);

  // Chaves curtas e ESTAVEIS (ordem alfabetica), pra o JSON diario diffar pouco.
  const ordered = [...repos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const keyOf = new Map(ordered.map(([nameWithOwner], i) => [nameWithOwner, `r${i}`]));

  const since = new Date(user.createdAt).toISOString();
  /** 'YYYY-MM-DD' -> { n, r: { repoKey: n } } */
  const days = Object.create(null);
  const seenOid = new Set(); // mesmo commit em varios repos (fork/mirror) conta 1x
  const repoTotals = new Map();

  for (const [nameWithOwner, repo] of ordered) {
    const key = keyOf.get(nameWithOwner);
    let cursor = null;
    let count = 0;
    for (;;) {
      const data = await gql(Q_HISTORY, {
        owner: repo.owner, name: repo.name, authorId: user.id, since, cursor,
      });
      const target = data && data.repository && data.repository.defaultBranchRef
        ? data.repository.defaultBranchRef.target
        : null;
      if (!target || !target.history) break; // repo vazio, sem acesso ou apagado

      for (const commit of target.history.nodes) {
        if (seenOid.has(commit.oid)) continue;
        seenOid.add(commit.oid);
        const day = localDay(commit.committedDate);
        const entry = days[day] || (days[day] = { n: 0, r: Object.create(null) });
        entry.n += 1;
        entry.r[key] = (entry.r[key] || 0) + 1;
        count += 1;
      }
      if (!target.history.pageInfo.hasNextPage) break;
      cursor = target.history.pageInfo.endCursor;
    }
    repoTotals.set(key, count);
    const shown = repo.isPrivate && !REVEAL_PRIVATE ? '(privado)' : nameWithOwner;
    console.log(`  ${String(count).padStart(5)} commits  ${shown}`);
  }

  let privateIdx = 0;
  const repoList = ordered.map(([nameWithOwner, repo]) => {
    const key = keyOf.get(nameWithOwner);
    const anon = repo.isPrivate && !REVEAL_PRIVATE;
    if (anon) privateIdx += 1;
    return {
      key,
      label: anon ? `privado #${privateIdx}` : nameWithOwner,
      private: repo.isPrivate,
      commits: repoTotals.get(key) || 0,
    };
  }).filter((r) => r.commits > 0);

  const dayKeys = Object.keys(days).sort();
  const total = dayKeys.reduce((a, d) => a + days[d].n, 0);
  const firstDay = dayKeys[0] || localDay(nowISO);
  const lastDay = localDay(nowISO);

  // Ancora fora do historico nao serve de recorte — cai pro primeiro dia.
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(ANCHOR) && ANCHOR > firstDay && ANCHOR < lastDay
    ? ANCHOR
    : null;
  if (ANCHOR && !anchor) console.warn(`AVISO: STATS_ANCHOR ${ANCHOR} fora de ${firstDay}..${lastDay} — recorte ancorado desativado.`);

  // Calendario de contribuicoes: commits + PRs + issues + reviews, do jeito que
  // o proprio GitHub conta nos quadradinhos do perfil. E a base do painel de
  // streak e do grafico de atividade — que antes vinham de servicos de terceiro
  // (streak-stats.demolab.com e github-readme-activity-graph) e sairam do ar.
  //
  // Fuso: o GitHub bucketiza o calendario no fuso do PERFIL, nao no STATS_TZ.
  // Nao da pra reconciliar sem recontar tudo, entao a data vem como a API manda
  // — e a mesma que o visitante ve no quadro verde logo acima do README.
  const calKeys = Object.keys(calendar).sort();
  // A semana corrente vem completa, com os dias futuros zerados: corta em lastDay.
  const calDays = Object.create(null);
  let calTotal = 0;
  for (const day of calKeys) {
    if (day > lastDay) break;
    const n = calendar[day];
    if (!n) continue; // dia zerado nao entra: firstDay/lastDay ja dizem que ele existe
    calDays[day] = n;
    calTotal += n;
  }
  const contributions = {
    total: calTotal,
    firstDay: calKeys[0] || firstDay,
    lastDay,
    days: calDays,
  };

  const payload = {
    schema: 1,
    user: user.login,
    name: user.name,
    generatedAt: nowISO,
    timezone: TZ,
    scope: HAS_PAT ? 'all' : 'public',
    privateReposIncluded: repoList.filter((r) => r.private).length,
    // Contribuicoes privadas que a API confirma existirem mas o token nao ve.
    // Sem PAT isso e o tamanho do buraco — a UI mostra o aviso.
    hiddenRestrictedContributions: HAS_PAT ? 0 : restricted,
    firstDay,
    lastDay,
    anchor,
    totalCommits: total,
    contributions,
    repos: repoList,
    days,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8');

  console.log(`> ${total} commits em ${dayKeys.length} dias -> data/commits.json (${calls} chamadas GraphQL)`);
  console.log(`> ${calTotal} contribuicoes no calendario desde ${contributions.firstDay}`);
  if (!HAS_PAT) {
    console.warn('');
    console.warn('AVISO: rodou sem STATS_TOKEN — repos privados NAO entraram.');
    if (restricted) console.warn(`       a API reporta ${restricted} contribuicoes privadas fora da conta.`);
    console.warn('       crie um PAT classico com escopo `repo` e salve em');
    console.warn('       Settings > Secrets and variables > Actions > STATS_TOKEN');
  }
}

main().catch((err) => {
  console.error(`FALHOU: ${err.message}`);
  process.exit(1);
});
