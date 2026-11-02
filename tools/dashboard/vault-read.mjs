/**
 * tools/dashboard/vault-read.mjs
 *
 * Lecture de l'or et du bronze du coffre pour un domaine donne.
 * Extrait la topologie du gold (noeuds reels, noeuds fantomes, aretes)
 * et les anomalies deterministes en les rattachant a leur page source (jugee vs heritee).
 * Suivi du flux d'ingestion bronze -> argent -> or.
 *
 * Provenance : recopie conforme de elements de la gate (hooks/vault.mjs : TYPES, readText, split, walk, links)
 * et de tools/plaud-sync/pending.mjs (l. 64-80). Voir KTD2 et KTD3.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { domainsOf } from '../vault-config.mjs';

// Table des dossiers -> types (TYPES de la gate)
export const TYPES = {
  sources: 'source',
  people: 'person',
  organizations: 'organization',
  projects: 'project',
  meetings: 'meeting',
  decisions: 'decision',
  concepts: 'concept',
  syntheses: 'synthesis',
};

// Normalisation des fins de ligne Windows (readText de la gate)
export const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// Decoupage frontmatter / body (split de la gate)
export const parseAliases = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const str = String(raw).trim();
  if (str.startsWith('[') && str.endsWith(']')) {
    return str
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return str.length > 0 ? [str] : [];
};

export const split = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (k) {
      let val = k[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fm[k[1]] = val;
    }
  }
  return { fm, head: m[1], body: m[2] };
};

// Parcours recursif des fichiers .md (walk de la gate)
export const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []
      )
    : [];

// Parcours recursif de TOUS les fichiers (pour le bronze)
export const walkAll = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkAll(path.join(dir, e.name)) : e.name.startsWith('.') ? [] : [path.join(dir, e.name)]
      )
    : [];

// Extraction des wikilinks (links de la gate)
// [^\[\]|#] : les [[[a]], [[b]]] du frontmatter ; le \ final vient des \| des tableaux Markdown.
export const extractLinks = (text) =>
  [...text.matchAll(/\[\[([^\[\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) =>
    m[1].trim().replace(/\\$/, '').replace(/\.md$/, '')
  );

// Nom de page normalise : « Écart Été » -> « ecart-ete », pour comparer un lien aux titres et alias.
export const slugify = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Sources declarees dans le frontmatter `sources:`, en wikilinks (`[[[sources/x]]]`)
 * ou en chemins bruts (`[sources/x, "sources/y"]`, la forme du domaine perso).
 */
export const declaredSources = (value) => {
  const text = String(value ?? '');
  const linked = extractLinks(text);
  const listed = linked.length > 0
    ? linked
    : text.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '').replace(/\.md$/, ''));
  return listed.filter((l) => l.startsWith('sources/'));
};

/**
 * Sources dont procede une ligne de page (CLAUDE.md §5.3 : on compte par source, pas par page).
 * Une page source est sa propre source ; une meeting, une fiche ou un ADR renvoient a la source
 * citee sur la ligne (^[[sources/…]]), sinon a l'unique source de leur frontmatter `sources:`.
 * Provenance indecidable (plusieurs sources, aucune en ligne) : la page compte pour elle-meme.
 */
const sourcesOfLine = (page, line) => {
  if (page.folder === 'sources') return [page.key];
  const inline = extractLinks(line).filter((l) => l.startsWith('sources/'));
  if (inline.length > 0) return inline;
  const declared = declaredSources(page.fm?.sources);
  return declared.length === 1 ? declared : [page.key];
};

/**
 * Lit la topologie du gold et calcule les anomalies deterministes pour un domaine.
 * Rapproche chaque anomalie du statut `gate:` de la page qui la porte (actionable vs dette).
 */
export const readGoldTopologyAndIssues = (vaultRoot, domain) => {
  const root = path.join(vaultRoot, 'wiki', domain);
  // Tous les autres domaines declares, comme `vault.mjs audit` (plan core/data, U4) : la parite des compteurs en depend.
  const otherPrefixes = domainsOf(vaultRoot).filter((d) => d !== domain).map((d) => `${d}/`);

  const pages = new Map(); // "folder/slug" -> pageData
  const typesPresent = new Set();
  let legacyPagesCount = 0;
  let judgedPagesCount = 0;

  // 1. Parcourir les 8 dossiers d'entites
  for (const f of walk(root)) {
    const rel = path.relative(root, f).split(path.sep);
    if (rel.length === 2 && TYPES[rel[0]]) {
      const folder = rel[0];
      const slug = rel[1].slice(0, -3);
      const key = `${folder}/${slug}`;
      const text = readText(f);
      const parts = split(text);
      // Si frontmatter absent, vault.mjs n'incremente pas legacy (voir vault.mjs:284-288)
      const isLegacy = parts ? !parts.fm?.gate : false;

      if (isLegacy) legacyPagesCount++;
      else judgedPagesCount++;

      typesPresent.add(TYPES[folder]);

      pages.set(key, {
        key,
        folder,
        slug,
        file: f,
        type: parts?.fm?.type || TYPES[folder] || folder,
        title: parts?.fm?.title ?? slug,
        gate: parts?.fm?.gate ?? null,
        updated: parts?.fm?.updated ?? null,
        aliases: parseAliases(parts?.fm?.aliases),
        isLegacy,
        fm: parts?.fm ?? null,
        body: parts?.body ?? text,
        text,
        links: extractLinks(text),
      });
    }
  }

  const catalog = ['index', 'log', 'overview'];
  const edges = [];
  const missingMap = new Map(); // target -> Array of sourceKeys
  const inbound = new Map([...pages.keys()].map((k) => [k, 0]));

  // Structure des issues
  const rawIssues = {
    frontmatter: [],
    'type-dossier': [],
    'lien-casse': [],
    orphelines: [],
    'domaine-lien': [],
    'hors-index': [],
    'index-fantome': [],
  };

  for (const [key, p] of pages) {
    if (!p.fm) {
      rawIssues.frontmatter.push({ sourceKey: key, detail: key, isLegacy: p.isLegacy });
    } else {
      if (p.fm.type !== TYPES[p.folder]) {
        rawIssues['type-dossier'].push({
          sourceKey: key,
          detail: `${key} (type=${p.fm.type ?? '?'})`,
          isLegacy: p.isLegacy,
        });
      }
    }

    for (const t of p.links) {
      if (t === key) {
        // Lien vers soi-meme : ignore
        continue;
      }
      if (otherPrefixes.some((p) => t.startsWith(p))) {
        rawIssues['domaine-lien'].push({
          sourceKey: key,
          target: t,
          detail: `${key} -> ${t}`,
          isLegacy: p.isLegacy,
        });
      } else if (pages.has(t)) {
        inbound.set(t, (inbound.get(t) ?? 0) + 1);
        edges.push({ source: key, target: t });
      } else if (!catalog.includes(t) && !/^(raw|silver)\//.test(t)) {
        if (!missingMap.has(t)) missingMap.set(t, []);
        missingMap.get(t).push({ sourceKey: key, isLegacy: p.isLegacy });
      }
    }
  }

  // Cibles absentes : lien casse ou lacune (CLAUDE.md §5.3, regle du 2026-10-02).
  // On juge chaque cible une fois. Anomalie si elle est citee par au moins deux sources distinctes
  // (une paire source + meeting de la meme reunion n'en fait qu'une), ou si elle designe une page
  // existante sous un autre nom (slug d'un autre dossier, titre, alias). Le reste est une lacune
  // voulue : informative, hors du compteur d'anomalies. « Centrale a sa source » demande de lire
  // la source : le lint en juge, pas cet outil.
  const pageByName = new Map();
  for (const [key, p] of pages) {
    for (const name of [p.slug, slugify(p.title), ...p.aliases.map(slugify)]) {
      if (name && !pageByName.has(name)) pageByName.set(name, key);
    }
  }

  const phantomNodes = [];
  const lacunes = [];
  for (const [t, citations] of [...missingMap].sort((a, b) => b[1].length - a[1].length)) {
    const citedBy = [...new Set(citations.map((c) => c.sourceKey))];
    const sources = new Set();
    for (const key of citedBy) {
      const p = pages.get(key);
      for (const line of p.text.split('\n')) {
        if (!extractLinks(line).includes(t)) continue;
        // Une source absente ne se compte pas comme sa propre source
        for (const s of sourcesOfLine(p, line)) if (s !== t) sources.add(s);
      }
    }
    const existingAs = pageByName.get(t.split('/').pop());
    const isLegacy = citations.every((c) => c.isLegacy);
    const status = existingAs ? 'alias' : sources.size >= 2 ? 'lien-casse' : 'lacune';

    phantomNodes.push({
      id: t,
      label: t,
      count: citations.length,
      citedBy: citations.map((c) => c.sourceKey),
      sources: [...sources],
      status,
      isGhost: true,
    });

    if (status === 'lacune') {
      lacunes.push({ target: t, sources: [...sources], citedBy, isLegacy });
      continue;
    }
    rawIssues['lien-casse'].push({
      sourceKey: citations.find((c) => !c.isLegacy)?.sourceKey ?? citedBy[0],
      target: t,
      detail:
        status === 'alias'
          ? `${t} : la page existe sous [[${existingAs}]] (cite par ${citedBy.join(', ')})`
          : `${t} : cite par ${sources.size} sources (${[...sources].join(', ')})`,
      isLegacy,
    });
  }

  // Pages orphelines (aucun lien entrant)
  for (const [key, n] of inbound) {
    if (n === 0) {
      const p = pages.get(key);
      rawIssues.orphelines.push({
        sourceKey: key,
        detail: key,
        isLegacy: p?.isLegacy ?? false,
      });
    }
  }

  // Index
  const indexFile = path.join(root, 'index.md');
  if (existsSync(indexFile)) {
    const indexed = new Set(extractLinks(readText(indexFile)));
    for (const [key, p] of pages) {
      if (!indexed.has(key)) {
        rawIssues['hors-index'].push({
          sourceKey: key,
          detail: key,
          isLegacy: p.isLegacy,
        });
      }
    }
    for (const t of indexed) {
      if (
        /^[a-z]+\/[a-z0-9-]+$/.test(t) &&
        TYPES[t.split('/')[0]] &&
        t.split('/')[1] !== 'slug' &&
        !pages.has(t)
      ) {
        rawIssues['index-fantome'].push({
          sourceKey: 'index.md',
          target: t,
          detail: t,
          isLegacy: false,
        });
      }
    }
  } else {
    rawIssues['hors-index'].push({
      sourceKey: 'index.md',
      detail: '(index.md absent)',
      isLegacy: false,
    });
  }

  // Separation Actionable vs Dette
  const actionable = {};
  const debt = {};
  const totalIssuesCount = {};

  for (const [cat, list] of Object.entries(rawIssues)) {
    actionable[cat] = list.filter((i) => !i.isLegacy);
    debt[cat] = list.filter((i) => i.isLegacy);
    totalIssuesCount[cat] = list.length;
  }

  return {
    pages,
    typesPresent,
    edges,
    phantomNodes,
    lacunes,
    legacyPagesCount,
    judgedPagesCount,
    issues: {
      actionable,
      debt,
    },
    totalIssuesCount,
    rawIssues,
  };
};

/**
 * Normalise un chemin raw pour comparaison (supprime un eventuel prefixe raw/<domaine>/ ou /).
 * Seul le prefixe du domaine lu est retire : un `raw:` qui viserait un autre domaine reste distinct, il ne
 * rapproche jamais un brut de ce domaine.
 */
const normalizeRaw = (rawPath, domain) => {
  if (!rawPath) return '';
  return rawPath.replace(/^[/\\]+/, '').replace(new RegExp(`^raw[/\\\\]${domain}[/\\\\]`), '').replace(/\\/g, '/');
};

/**
 * Lit le statut du bronze et de l'argent pour un domaine.
 * Rapproche les sources bronze contre l'argent et l'or,
 * et separe le fonds anterieur a l'amorcage (dette) des nouveautes (actions).
 */
export const readBronzeAndSilverStatus = (vaultRoot, domain) => {
  const rawDir = path.join(vaultRoot, 'raw', domain);
  const silverDir = path.join(vaultRoot, 'silver', domain);
  const goldSourcesDir = path.join(vaultRoot, 'wiki', domain, 'sources');
  const seedFile = path.join(silverDir, 'heritage', '_seed.json');

  let seedDate = null;
  if (existsSync(seedFile)) {
    try {
      const seed = JSON.parse(readText(seedFile));
      if (seed?.at) seedDate = seed.at.slice(0, 10);
    } catch {
      // Ignorer erreur de parse
    }
  }

  // 1. Collecter raws de l'or
  const goldRaws = new Set();
  if (existsSync(goldSourcesDir)) {
    for (const f of walk(goldSourcesDir)) {
      const parts = split(readText(f));
      if (parts?.fm?.raw) goldRaws.add(normalizeRaw(parts.fm.raw, domain));
    }
  }

  // 2. Collecter raws de l'argent (hors heritage)
  const silverFiches = [];
  if (existsSync(silverDir)) {
    for (const e of readdirSync(silverDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const f = path.join(silverDir, e.name);
      const parts = split(readText(f));
      if (parts?.fm?.raw) {
        const norm = normalizeRaw(parts.fm.raw, domain);
        const vaultRaw = parts.fm.raw.startsWith('raw/') ? parts.fm.raw : path.join('raw', domain, parts.fm.raw);
        silverFiches.push({
          file: f,
          slug: e.name.slice(0, -3),
          raw: vaultRaw,
          rawOrig: parts.fm.raw,
          normalizedRaw: norm,
        });
      }
    }
  }
  const silverRawsSet = new Set(silverFiches.map((sf) => sf.normalizedRaw));

  // 3. Fiches argent sans page or (en cours d'ingestion)
  const actionableSilverWithoutGold = silverFiches.filter((sf) => !goldRaws.has(sf.normalizedRaw));

  // 4. Parcourir le bronze
  const allBronze = walkAll(rawDir);
  const actionableBronzeWithoutSilver = [];
  const debtBronzeFiles = [];

  for (const absFile of allBronze) {
    const relFromRawDir = path.relative(rawDir, absFile);
    const relFromVault = path.join('raw', domain, relFromRawDir);
    const norm = normalizeRaw(relFromRawDir, domain);

    // Deja dans l'or ?
    if (goldRaws.has(norm)) {
      continue;
    }

    // Deja dans l'argent ?
    if (silverRawsSet.has(norm)) {
      continue;
    }

    // Source bronze sans suite : verifier si elle est anterieure a l'amorcage
    const baseName = path.basename(absFile);
    const dateMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})/);
    const fileDate = dateMatch ? dateMatch[1] : null;

    if (seedDate && fileDate && fileDate < seedDate) {
      debtBronzeFiles.push(relFromVault);
    } else {
      actionableBronzeWithoutSilver.push(relFromVault);
    }
  }

  return {
    seedDate,
    actionableSilverWithoutGold,
    actionableBronzeWithoutSilver,
    debtBronzeFiles,
    debtBronzeCount: debtBronzeFiles.length,
    totalBronzeCount: allBronze.length,
    totalSilverCount: silverFiches.length,
  };
};
