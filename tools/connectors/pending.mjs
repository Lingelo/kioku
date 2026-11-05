#!/usr/bin/env node
/**
 * File d'attente d'ingestion d'un circuit de capture : ce que le tri vient de ranger dans raw/<domaine>/ et qui n'est
 * pas encore entre dans l'or. Commune a tous les connecteurs (Plaud, mail) : le tri et l'ingestion sont les memes.
 *
 *   node tools/connectors/pending.mjs --state <dossier> snapshot    photo de raw/ (avant le tri)
 *   node tools/connectors/pending.mjs --state <dossier> queue       ajoute a la file ce qui est apparu dans raw/ depuis la photo
 *   node tools/connectors/pending.mjs --state <dossier> list        sources a ingerer, une par ligne : <domaine><TAB><chemin relatif a raw/<domaine>/><TAB><etat>
 *   node tools/connectors/pending.mjs --state <dossier> add <domaine> <chemin relatif>   ajoute a la main (source rangee par un /triage manuel)
 *
 * `--state` : le dossier d'etat local du connecteur, relatif au coffre (Plaud : tools/plaud-sync, voir
 * tools/plaud-sync/pending.mjs qui le fixe). Le coffre vise est CLAUDE_PROJECT_DIR, sinon le dossier courant.
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
 *   neuf       rien d'ecrit, ou fiche argent absente          -> l'ingestion reste entierement a faire
 *   argent     fiche argent presente, page or absente         -> redigee mais PAS entree : gate a reprendre
 *   candidats  des candidates de cette source restent sous .candidats/wiki/<domaine>/ -> gate seulement
 * Une page retenue par la gate (quarantaine) laisse aussi sa source en `argent` : c'est voulu, elle attend une
 * decision et `vault.mjs undecided` la nomme.
 *
 * Page or presente ne suffit pas : la gate admet page par page (« si un relecteur ne repond pas, sa page n'entre
 * pas — les autres, oui »). La page source pouvait entrer et une page d'entite rester sous .candidats/, invisible
 * du rapport. Une source n'est donc traitee que si aucune candidate ne la cite encore : une candidate `sources/`
 * de meme `raw:`, ou toute candidate dont le `sources:` nomme sa page source. Une page retenue quitte .candidats/
 * (quarantaine) : ce qui y reste n'a vraiment pas fini la gate. Angle mort, dit : `check` n'impose pas `sources:`
 * hors des pages sources/, une candidate qui ne le remplit pas n'est rattachee a aucune source.
 * `list` rend alors une 4e colonne : ces candidates, en chemins relatifs a .candidats/wiki/<domaine>/, separees par des virgules.
 *
 * Etat local, non versionne : <dossier d'etat>/.snapshot.json et .queue.json (Plaud : voir le bloc gere du .gitignore).
 * Ce script lit des noms de fichiers et une ligne de frontmatter (`raw:`) ; il ne lit aucun contenu de source.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { domainsOf, vaultRoot } from '../vault-config.mjs';

/** Un dossier d'etat relatif au coffre, sans remontee ni chemin absolu : l'etat d'un connecteur reste dans le coffre. */
export const validState = (state) =>
  typeof state === 'string' && state !== '' && !path.isAbsolute(state) && !state.split(/[/\\]/).some((s) => s === '..' || s === '');

/**
 * La file d'un connecteur, sur le coffre `vault`, etat dans `<vault>/<state>/`. Rend le code de sortie.
 * Configuration absente ou invalide : on s'arrete (code 1), rien n'est ecrit.
 */
export const runPending = (args, { vault = vaultRoot(undefined), state } = {}) => {
  if (!validState(state)) {
    console.error(`pending.mjs : --state attend un dossier relatif au coffre, sans "..", recu "${state ?? ''}".`);
    return 1;
  }
  const VAULT = vault;
  let DOMAINS;
  try {
    DOMAINS = domainsOf(VAULT);
  } catch (error) {
    console.error(`pending.mjs : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const STATE_DIR = path.join(VAULT, state); // l'etat suit le coffre vise, pas l'emplacement du script
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

  /** Le frontmatter d'un fichier .md, ou null. */
  const headOf = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? null;
  const rawOf = (head) => head?.match(/^raw:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? null;
  /**
   * Les slugs de pages source nommes par `sources:` : en ligne (`[a, b]`) ou en liste YAML sur les lignes suivantes,
   * en wikilinks (`[[sources/x]]`) ou en chemins (`sources/x`). Seul le frontmatter est lu.
   */
  const sourcesOf = (head) => {
    const block = head?.match(/^sources:(.*(?:\n(?:[ \t]+|-).*)*)/m)?.[1] ?? '';
    return new Set([...block.matchAll(/sources\/([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1]));
  };

  /** Les `raw:` cites par les fichiers .md d'un dossier, avec le slug du fichier (frontmatter seulement, pas de recursion). */
  const rawsIn = (dir) => {
    if (!existsSync(dir)) return new Map();
    const raws = new Map();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const raw = rawOf(headOf(path.join(dir, e.name)));
      if (raw) raws.set(e.name.slice(0, -3), raw);
    }
    return raws;
  };
  const rawsCitedIn = (dir) => new Set(rawsIn(dir).values());

  /** Fiches argent du domaine (racine seulement : heritage/ est ferme et sans objet ici). */
  const silverRaws = (domain) => rawsCitedIn(path.join(VAULT, 'silver', domain));

  /** Pages or `sources/` du domaine : le temoin qu'une source est entree dans le wiki (necessaire, pas suffisant). */
  const goldSources = (domain) => rawsIn(path.join(VAULT, 'wiki', domain, 'sources'));

  /** Candidates du domaine : { rel (relatif a .candidats/wiki/<domaine>/), folder, slug, raw, sources }. */
  const candidates = (domain) => {
    const root = path.join(VAULT, '.candidats', 'wiki', domain);
    if (!existsSync(root)) return [];
    const out = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of readdirSync(path.join(root, d.name), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        const head = headOf(path.join(root, d.name, f.name));
        out.push({ rel: `${d.name}/${f.name}`, folder: d.name, slug: f.name.slice(0, -3), raw: rawOf(head), sources: sourcesOf(head) });
      }
    }
    return out;
  };

  /** Les candidates qui citent encore la source `rel` (voir l'en-tete). */
  const leftoverFor = (rel, gold, cands) => {
    const slugs = new Set([...gold].filter(([, raw]) => raw === rel).map(([slug]) => slug));
    for (const c of cands) if (c.folder === 'sources' && c.raw === rel) slugs.add(c.slug);
    return cands.filter((c) => (c.folder === 'sources' && c.raw === rel) || [...c.sources].some((s) => slugs.has(s))).map((c) => c.rel).sort();
  };

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

  /** Retire de la file ce qui est entre dans l'or sans candidate restante ; imprime le reste avec son etat. */
  const list = () => {
    const silver = Object.fromEntries(DOMAINS.map((d) => [d, silverRaws(d)]));
    const gold = Object.fromEntries(DOMAINS.map((d) => [d, goldSources(d)]));
    const cands = Object.fromEntries(DOMAINS.map((d) => [d, candidates(d)]));
    const q = readJson(QUEUE, []);
    const rest = [];
    for (const x of q) {
      if (!existsSync(path.join(VAULT, 'raw', x.domain, x.rel))) continue;
      const left = leftoverFor(x.rel, gold[x.domain] ?? new Map(), cands[x.domain] ?? []);
      const inGold = [...(gold[x.domain]?.values() ?? [])].includes(x.rel);
      if (inGold && !left.length) continue;
      rest.push({ ...x, left });
    }
    if (rest.length !== q.length) writeJson(QUEUE, rest.map(({ domain, rel }) => ({ domain, rel })));
    for (const x of rest) {
      const state = x.left.length ? 'candidats' : silver[x.domain]?.has(x.rel) ? 'argent' : 'neuf';
      console.log(`${x.domain}\t${x.rel}\t${state}${x.left.length ? `\t${x.left.join(',')}` : ''}`);
    }
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

  const [cmd, ...rest] = args;
  const commands = { snapshot: () => (snapshot(), 0), queue, list, add: () => add(rest) };
  if (!commands[cmd]) {
    console.error('usage : pending.mjs --state <dossier> snapshot | queue | list | add <domaine> <chemin>');
    return 1;
  }
  return commands[cmd]();
};

/** Ce module est-il le script lance (et pas un import) ? Chemin reel des deux cotes : un core installe par lien symbolique. */
export const isMain = (url, argv1 = process.argv[1]) => {
  try {
    return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

// En ligne de commande : `--state <dossier>` puis la commande.
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--state');
  const state = i >= 0 ? argv[i + 1] : undefined;
  process.exit(runPending(i >= 0 ? [...argv.slice(0, i), ...argv.slice(i + 2)] : argv, { state }));
}
