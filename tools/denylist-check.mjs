#!/usr/bin/env node
/**
 * Denylist du depot core (plan core/data, KTD9, U11) : refuse un push qui porte un terme prive.
 *
 *   node tools/denylist-check.mjs pre-push <remote> <url>     hook git pre-push : lit les refs poussees sur stdin
 *   node tools/denylist-check.mjs range <base>..<tete>         controle une plage de commits
 *   node tools/denylist-check.mjs tree                         controle l'arbre courant (fichiers suivis)
 *   node tools/denylist-check.mjs history                      controle tout l'historique, messages compris (audit U13)
 *
 * La liste vit HORS du depot, dans le fichier que nomme la variable KIOKU_DENYLIST : un terme par ligne, `#` pour un
 * commentaire, insensible a la casse et aux accents. Le core ne contient que ce script, jamais la liste.
 * Variable absente, fichier introuvable ou liste vide : refus. Un controle qui ne sait pas quoi chercher laisse tout
 * passer ; il echoue ferme.
 *
 * Ce qui est controle dans une plage : le contenu ajoute (diffs), les messages de commit, les noms et adresses
 * d'auteur et de commiteur, le nom des refs poussees (branches, tags). Les fichiers binaires sont ignores (dits).
 * Le message d'erreur nomme le terme et l'endroit, jamais la ligne entiere : le terme est deja connu de l'utilisateur.
 *
 * Limite, dite : `git push --no-verify` saute le hook. L'audit avant ouverture (U13) rejoue `history`.
 * Codes : 0 rien trouve ; 1 terme trouve ; 2 controle impossible (liste absente, git en echec).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const ZERO = /^0+$/;

/** Forme comparable : minuscules, sans accents. */
export const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lit la liste ; leve une erreur nommee si elle est absente ou vide. */
export const loadDenylist = (env = process.env) => {
  const file = env.KIOKU_DENYLIST;
  if (!file) throw new Error('KIOKU_DENYLIST n\'est pas defini : sans liste, rien ne peut etre controle (refus)');
  if (!existsSync(file)) throw new Error(`denylist introuvable : ${file}`);
  const terms = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  if (!terms.length) throw new Error(`denylist vide : ${file}`);
  return terms;
};

/**
 * Un matcher par terme. Un terme court (4 caracteres ou moins) ou d'un seul mot est cherche en mot entier, pour
 * qu'un prenom court ne se declenche pas au milieu d'un autre mot ; un terme plus long, ou compose, en sous-chaine.
 */
export const matchers = (terms) =>
  terms.map((term) => {
    const t = fold(term);
    const whole = t.length <= 4 || !/\s/.test(t);
    const re = new RegExp(whole ? `(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])` : escapeRe(t));
    return { term, test: (text) => re.test(fold(text)) };
  });

/** Cherche les termes dans une liste de { where, text }. Rend [{ term, where }]. */
export const scan = (items, terms) => {
  const ms = matchers(terms);
  const hits = [];
  for (const { where, text } of items) for (const m of ms) if (m.test(text)) hits.push({ term: m.term, where });
  return hits;
};

const git = (args, { input } = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} : ${(r.stderr || '').trim()}`);
  return r.stdout;
};

/**
 * Le code tiers embarque (librairies minifiees sous un dossier vendor/) n'est pas controle : il porte des mots courants
 * (noms d'entreprises, de variables) sans rapport avec le coffre, et n'est jamais ecrit a la main. Son NOM de fichier,
 * lui, l'est toujours.
 */
export const VENDORED = /(^|\/)vendor\//;

/** Les lignes ajoutees d'un diff, avec le fichier qui les porte. Les binaires et le code tiers sont comptes a part. */
const addedLines = (diff) => {
  const items = [];
  let file = '?';
  let binaries = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      items.push({ where: `chemin ${file}`, text: file });
    } else if (line.startsWith('Binary files ')) binaries++;
    else if (line.startsWith('+') && !line.startsWith('+++') && !VENDORED.test(file)) items.push({ where: `contenu ${file}`, text: line.slice(1) });
  }
  return { items, binaries };
};

/** Ce que porte une plage de commits (arguments de rev-list) : diffs ajoutes, messages, auteurs et commiteurs. */
export const rangeItems = (revs) => {
  const items = [];
  const shas = git(['rev-list', ...revs]).split('\n').filter(Boolean);
  let binaries = 0;
  for (const sha of shas) {
    const meta = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', sha]).split('\n');
    const [an, ae, cn, ce, ...body] = meta;
    const short = sha.slice(0, 8);
    items.push({ where: `auteur ${short}`, text: `${an} ${ae}` }, { where: `commiteur ${short}`, text: `${cn} ${ce}` });
    items.push({ where: `message ${short}`, text: body.join('\n') });
    const added = addedLines(git(['show', '--format=', '--no-color', '--no-ext-diff', sha]));
    items.push(...added.items.map((i) => ({ ...i, where: `${i.where} (${short})` })));
    binaries += added.binaries;
  }
  return { items, binaries, commits: shas.length };
};

/** Les fichiers suivis de l'arbre courant. */
export const treeItems = () => {
  const items = [];
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    items.push({ where: `chemin ${file}`, text: file });
    if (VENDORED.test(file)) continue; // code tiers : nom controle, contenu non
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binaire
    items.push({ where: `fichier ${file}`, text: buf.toString('utf8') });
  }
  return items;
};

/**
 * Hook pre-push : stdin porte une ligne par ref poussee, « <ref locale> <sha local> <ref distante> <sha distant> ».
 * Une suppression (sha local nul) ne pousse rien. Une branche neuve (sha distant nul) est controlee depuis la racine
 * de l'historique, moins ce que le remote connait deja.
 */
export const prePushItems = (stdin, remote) => {
  const items = [];
  let binaries = 0;
  let commits = 0;
  for (const line of stdin.split('\n').filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (ZERO.test(localSha)) continue;
    items.push({ where: 'ref locale', text: localRef }, { where: 'ref distante', text: remoteRef });
    // Sha distant inconnu ici (force-push apres reecriture, clone neuf) : la plage est impossible, on controle tout ce
    // qui est pousse, comme pour une branche neuve. Plus large, jamais plus etroit.
    const known = !ZERO.test(remoteSha) && spawnSync('git', ['rev-parse', '--verify', '--quiet', `${remoteSha}^{commit}`]).status === 0;
    const revs = known ? [`${remoteSha}..${localSha}`] : remote ? [localSha, '--not', `--remotes=${remote}`] : [localSha];
    const r = rangeItems(revs);
    items.push(...r.items);
    binaries += r.binaries;
    commits += r.commits;
  }
  return { items, binaries, commits };
};

const report = (hits, scope) => {
  if (!hits.length) {
    console.log(`denylist : rien trouve (${scope})`);
    return 0;
  }
  console.error(`denylist : ${hits.length} occurrence(s) d'un terme prive — push refuse (${scope})`);
  for (const h of hits) console.error(`  « ${h.term} » : ${h.where}`);
  console.error('Retire le terme (contenu, message ou auteur, puis reecris les commits concernes) et relance.');
  return 1;
};

const main = (argv, stdin) => {
  const [cmd, ...rest] = argv;
  const terms = loadDenylist();
  if (cmd === 'pre-push') {
    const r = prePushItems(stdin, rest[0]);
    return report(scan(r.items, terms), `${r.commits} commit(s)${r.binaries ? `, ${r.binaries} fichier(s) binaire(s) non lus` : ''}`);
  }
  if (cmd === 'range') {
    if (!rest[0]) throw new Error('usage : range <base>..<tete>');
    const r = rangeItems([rest[0]]);
    return report(scan(r.items, terms), `${r.commits} commit(s)`);
  }
  if (cmd === 'tree') return report(scan(treeItems(), terms), 'arbre courant');
  if (cmd === 'history') {
    const r = rangeItems(['--all']);
    const refs = git(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean).map((ref) => ({ where: 'ref', text: ref }));
    return report(scan([...r.items, ...refs], terms), `historique complet, ${r.commits} commit(s)`);
  }
  throw new Error('usage : denylist-check.mjs pre-push|range|tree|history');
};

const isDirect = process.argv[1] && new URL(import.meta.url).pathname === (await import('node:path')).resolve(process.argv[1]);
if (isDirect) {
  const stdin = process.argv[2] === 'pre-push' ? readFileSync(0, 'utf8') : '';
  try {
    process.exit(main(process.argv.slice(2), stdin));
  } catch (error) {
    console.error(`denylist : ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
