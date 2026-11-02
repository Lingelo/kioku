#!/usr/bin/env node
/**
 * File d'attente d'ingestion : ce que le tri vient de ranger dans raw/<domaine>/ et qui n'a pas encore de fiche argent.
 *
 *   node tools/plaud-sync/pending.mjs snapshot    photo de raw/ (avant le tri)
 *   node tools/plaud-sync/pending.mjs queue       ajoute a la file ce qui est apparu dans raw/ depuis la photo
 *   node tools/plaud-sync/pending.mjs list        sources a ingerer, une par ligne : <domaine><TAB><chemin relatif a raw/<domaine>/><TAB><etat>
 *   node tools/plaud-sync/pending.mjs add <domaine> <chemin relatif>   ajoute a la main (source rangee par un /triage manuel)
 *
 * Pourquoi une file et pas « tout raw/ sans page or » : les reunions heritees (raw/pro/meetings) ont ete traitees
 * en raccourci bronze -> or (CLAUDE.md §3, amorcage) ; elles ne sont pas a ingerer. Seul ce que CE circuit vient
 * de ranger l'est.
 *
 * « Ingere » se verifie sur les fichiers, jamais sur la parole d'une session — et le fichier qui fait foi est
 * la PAGE OR : une source est traitee quand wiki/<domaine>/sources/<slug>.md porte `raw:` = son chemin.
 * Le critere etait auparavant la fiche argent, ecrite a l'etape 2 sur 3 : le 22/09, une session s'est arretee
 * apres avoir redige les candidates et avant la gate, et le rapport a annonce « 1/1 ingeree » pour une source
 * qui n'etait jamais entree dans l'or. Trois pages sont restees dans .candidats/, invisibles du rapport comme
 * de `vault.mjs undecided`. L'etat rendu par `list` distingue donc les deux marches :
 *   neuf    rien d'ecrit, ou fiche argent absente             -> l'ingestion reste entierement a faire
 *   argent  fiche argent presente, page or absente            -> redigee mais PAS entree : gate a reprendre
 * Une page retenue par la gate (quarantaine) laisse aussi sa source en `argent` : c'est voulu, elle attend une
 * decision et `vault.mjs undecided` la nomme.
 *
 * Etat local, non versionne : tools/plaud-sync/.snapshot.json et .queue.json (voir .gitignore).
 * Ce script lit des noms de fichiers et une ligne de frontmatter (`raw:`) ; il ne lit aucun contenu de source.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { domainsOf, vaultRoot } from '../vault-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = vaultRoot(undefined);
// Les domaines du coffre vise ; configuration absente ou invalide : on s'arrete, rien n'est ecrit.
let DOMAINS;
try {
  DOMAINS = domainsOf(VAULT);
} catch (error) {
  console.error(`pending.mjs : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const STATE_DIR = path.join(VAULT, 'tools', 'plaud-sync'); // l'etat suit le coffre vise, pas l'emplacement du script
const SNAPSHOT = path.join(STATE_DIR, '.snapshot.json');
const QUEUE = path.join(STATE_DIR, '.queue.json');

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, value) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
};
const posix = (p) => p.split(path.sep).join('/');

/** Tous les fichiers de raw/<domaine>/, en chemins relatifs a raw/<domaine>/ (meetings/x.md). */
const rawFiles = (domain) => {
  const root = path.join(VAULT, 'raw', domain);
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.push(posix(path.relative(root, abs)));
    }
  };
  walk(root);
  return out.sort();
};

/** Les `raw:` cites par les fichiers .md d'un dossier (frontmatter seulement, pas de recursion). */
const rawsCitedIn = (dir) => {
  if (!existsSync(dir)) return new Set();
  const raws = new Set();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const head = readFileSync(path.join(dir, e.name), 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    const m = head?.[1].match(/^raw:\s*["']?(.+?)["']?\s*$/m);
    if (m) raws.add(m[1]);
  }
  return raws;
};

/** Fiches argent du domaine (racine seulement : heritage/ est ferme et sans objet ici). */
const silverRaws = (domain) => rawsCitedIn(path.join(VAULT, 'silver', domain));

/** Pages or `sources/` du domaine : le seul temoin qu'une source est REELLEMENT entree dans le wiki. */
const goldRaws = (domain) => rawsCitedIn(path.join(VAULT, 'wiki', domain, 'sources'));

const snapshot = () => {
  writeJson(SNAPSHOT, Object.fromEntries(DOMAINS.map((d) => [d, rawFiles(d)])));
  console.log(`photo de raw/ : ${DOMAINS.map((d) => `${d} ${rawFiles(d).length}`).join(', ')}`);
};

const queue = () => {
  if (!existsSync(SNAPSHOT)) {
    console.error('pas de photo : lance `snapshot` avant le tri.');
    return 1;
  }
  const before = readJson(SNAPSHOT, {});
  const q = readJson(QUEUE, []);
  let added = 0;
  for (const domain of DOMAINS) {
    const known = new Set(before[domain] ?? []);
    for (const rel of rawFiles(domain)) {
      if (known.has(rel) || q.some((x) => x.domain === domain && x.rel === rel)) continue;
      q.push({ domain, rel });
      added++;
      console.log(`file : ${domain}  ${rel}`);
    }
  }
  writeJson(QUEUE, q);
  unlinkSync(SNAPSHOT);
  console.log(`${added} source(s) rangee(s) par le tri, ajoutee(s) a la file.`);
  return 0;
};

/** Retire de la file ce qui est entre dans l'or ; imprime le reste avec son etat (neuf | argent). */
const list = () => {
  const silver = Object.fromEntries(DOMAINS.map((d) => [d, silverRaws(d)]));
  const gold = Object.fromEntries(DOMAINS.map((d) => [d, goldRaws(d)]));
  const q = readJson(QUEUE, []);
  const rest = q.filter((x) => existsSync(path.join(VAULT, 'raw', x.domain, x.rel)) && !gold[x.domain]?.has(x.rel));
  if (rest.length !== q.length) writeJson(QUEUE, rest);
  for (const x of rest) console.log(`${x.domain}\t${x.rel}\t${silver[x.domain]?.has(x.rel) ? 'argent' : 'neuf'}`);
  return 0;
};

const add = ([domain, rel]) => {
  if (!DOMAINS.includes(domain) || !rel || !existsSync(path.join(VAULT, 'raw', domain, rel))) {
    console.error(`usage : add <${DOMAINS.join('|')}> <chemin relatif a raw/<domaine>/> (le fichier doit exister)`);
    return 1;
  }
  const q = readJson(QUEUE, []);
  if (!q.some((x) => x.domain === domain && x.rel === rel)) q.push({ domain, rel });
  writeJson(QUEUE, q);
  console.log(`file : ${domain}  ${rel}`);
  return 0;
};

const [cmd, ...args] = process.argv.slice(2);
const commands = { snapshot: () => (snapshot(), 0), queue, list, add: () => add(args) };
if (!commands[cmd]) {
  console.error('usage : pending.mjs snapshot | queue | list | add <domaine> <chemin>');
  process.exit(1);
}
process.exit(commands[cmd]());
