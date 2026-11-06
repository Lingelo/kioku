#!/usr/bin/env node
/**
 * vault.mjs — la gate du coffre, sans dependance et sans Minute.
 *
 *   kioku check <candidate>...     format et provenance (sans modele)
 * Les domaines viennent de la configuration du coffre (kioku.config.json, voir config.mjs) : aucun nom n'est ecrit ici.
 * L'attribut org: et les commandes de migration (propose-org, tag-org, propose-raw, tag-raw) valent pour les
 * domaines dont l'extension org est active.
 *
 *   kioku verdict <candidate> ok|hold <code> [note] --relecteur <domaine>
 *                                                         verdict du relecteur du domaine, lie au contenu exact (sha256)
 *   kioku promote <candidate>...   ecrit sous wiki/<domaine>/ si check + verdict ok ;
 *                                                         verdict hold -> quarantaine
 *   kioku stage <domaine> <dossier/slug>...
 *                                                         copie une page de l'or sous .candidats/ pour la modifier
 *                                                         (session ingest de son domaine ; sans gate:, repasse la gate)
 *   kioku rotate-log <domaine> [--dry-run]
 *                                                         archive les mois revolus de wiki/<D>/log.md dans wiki/<D>/log/<AAAA-MM>.md
 *                                                         (session query ou ingest de son domaine ; propose par le lint, valide par l'utilisateur)
 *   kioku propose-org <domaine> --tour sources|derivees
 *                                                         propose l'attribut org: des pages sans org: (TSV chemin, org, raison ;
 *                                                         aucun contenu de page) : tour 1 les sources, tour 2 le reste par union
 *   kioku tag-org <fichier.tsv> [--dry-run]
 *                                                         applique un TSV relu : n'ecrit que org: et org-tag: (corps intact a l'octet),
 *                                                         session query ou ingest d'un domaine a extension org, verrou Plaud,
 *                                                         aucune candidate en attente
 *   kioku propose-raw <domaine> | tag-raw <fichier.tsv> [--dry-run]
 *                                                         relie le bronze herite aux pages sources sans raw: (memes gardes)
 *   kioku quarantine <domaine> <slug> <code> <raw> [note]
 *                                                         consigne une source ecartee (pointeur, jamais le texte)
 *   kioku undecided [domaine]      liste ce qui attend une decision (codes, jamais d'extraits), avec la nature
 *                                                         (pointeur | retenue | signalee) et les actions de decide admises ;
 *                                                         un pointeur ne se decide que par drop, qui ne touche aucune page
 *   kioku audit <domaine>          anomalies deterministes : liens casses, orphelines, index, frontmatter…
 *   kioku flag <domaine> <dossier/slug> <code> [note]
 *                                                         signale une page deja dans le wiki (ancien fonds)
 *   kioku decide <domaine> <nom> keep|correct|drop [note]
 *                                                         applique la decision EXPLICITE de l'utilisateur
 *   kioku seed <domaine>           amorce : copie l'or existant dans silver/<domaine>/heritage/
 *   kioku commit <domaine> [-m "<message>"] [--dry-run]
 *                                                         commite le travail du domaine (chemins calcules par le code,
 *                                                         refus si une candidate attend ; jamais de push)
 *                                                         (instantane de depart, une seule fois, ferme ensuite)
 *
 * Une candidate vit sous .candidats/wiki/<domaine>/<dossier>/<slug>.md (chemin final).
 * Codes de sortie : 0 ok, 1 refusee (format/provenance), 3 pas de verdict, 4 retenue (quarantaine).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { formatOrgList, loadOrgs, parseOrgList, sameOrgSet } from './orgs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? path.join(HERE, '..', '..'));
// Configuration absente ou invalide : on sort en code 1 avec le probleme nomme, avant toute ecriture.
let CFG;
try {
  CFG = loadConfig(VAULT);
} catch (error) {
  console.log(`vault.mjs : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const DOMAINS = CFG.domains;
const DOMAIN_LIST = DOMAINS.join('|');
// Les autres domaines declares, en alternative de regex (un identifiant est kebab-case : rien a echapper hors `-`).
const otherDomainsRe = (domain) => CFG.others(domain).join('|');
// Le registre de l'extension org d'un domaine ; null si le domaine n'a pas l'extension.
const registryOf = (domain) => CFG.orgRegistry(domain);
const loadRegistry = (domain) => loadOrgs(VAULT, registryOf(domain));
const RULES = 'v1';
const TYPES = {
  sources: 'source',
  people: 'person',
  organizations: 'organization',
  projects: 'project',
  meetings: 'meeting',
  decisions: 'decision',
  concepts: 'concept',
  syntheses: 'synthesis',
};
const DATES = {
  source: ['ingested_on', 'source_type'],
  meeting: ['date'],
  decision: ['decided_on'],
  person: ['created', 'updated'],
  organization: ['created', 'updated'],
  project: ['created', 'updated'],
  concept: ['created', 'updated'],
  synthesis: ['created', 'updated'],
};
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /(password|mot de passe|passwd|api[_-]?key|secret)\s*[:=]\s*\S{6,}/i,
];
// Pre-filtre indicatif : un mot ne condamne rien (« incapable de se connecter » parle d'un systeme),
// il oriente seulement le relecteur. Le jugement est celui du relecteur, pas de cette liste.
const LEXIQUE = /\b(connard|connasse|salaud|abruti|cr[eé]tin|d[eé]bile|idiot|imb[eé]cile|incomp[eé]tent|incapable|nul(le)? [àa] chier|ferme ta gueule|enfoir[eé])\b/i;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const split = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (k) fm[k[1]] = k[2].trim();
  }
  return { fm, head: m[1], body: m[2] };
};

const silverPath = (c) => path.join(VAULT, 'silver', c.domain, `${c.slug}.md`);

/**
 * `org:` (CLAUDE.md §6) : ou la connaissance a ete acquise, sur toute page d'un domaine a extension org ; jamais ailleurs.
 * Une liste sur une ligne d'identifiants du registre, comparee comme un ensemble (l'ordre ne porte aucun sens).
 * Absent : avertissement tant que le registre dit org_required: false (migration en cours), erreur ensuite.
 * `fm` vient de split, `head` est le frontmatter brut (pour reperer une liste YAML sur plusieurs lignes).
 */
const checkOrg = (domain, fm, head, errors, warnings) => {
  const present = /^org:/m.test(head);
  if (!registryOf(domain)) {
    if (present) errors.push(`org : une page ${domain} ne porte pas org: (le domaine n'a pas l'extension org)`);
    return null;
  }
  let reg;
  try {
    reg = loadRegistry(domain);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
  if (!present) {
    (reg.required ? errors : warnings).push(`org : attribut absent (org: [<identifiant>, ...], identifiants de ${path.relative(VAULT, registryOf(domain))})`);
    return null;
  }
  const list = parseOrgList(fm.org);
  if (!list) return errors.push('org : liste attendue sur une seule ligne, ex. org: [acme, globex]'), null;
  if (!list.length) return errors.push('org : liste vide'), null;
  const unknown = list.filter((id) => !reg.ids.has(id));
  if (unknown.length) return errors.push(`org : hors registre : ${unknown.join(', ')} (connus : ${[...reg.ids].join(', ')})`), null;
  return list;
};

/** Une candidate : son chemin final se lit dans son chemin. */
const load = (file) => {
  const abs = path.resolve(process.cwd(), file);
  const rel = path.relative(path.join(VAULT, '.candidats'), abs).split(path.sep);
  if (rel[0] === '..' || rel[0] !== 'wiki' || rel.length !== 4 || !rel[3].endsWith('.md')) {
    return { abs, error: 'chemin' };
  }
  const [, domain, folder, name] = rel;
  return { abs, domain, folder, name, slug: name.slice(0, -3), exists: existsSync(abs) };
};

const check = (c) => {
  const errors = [];
  const warnings = [];
  if (c.error) return { errors: [`chemin : attendu .candidats/wiki/<${DOMAIN_LIST}>/<dossier>/<slug>.md`], warnings };
  if (!c.exists) return { errors: ['introuvable'], warnings };
  // Domaine non declare : on s'arrete la, les controles suivants (org, autres domaines) supposent un domaine connu.
  if (!DOMAINS.includes(c.domain)) return { errors: [`domaine : "${c.domain}" n'est pas un domaine declare (${DOMAIN_LIST})`], warnings };
  const others = otherDomainsRe(c.domain);
  if (!TYPES[c.folder]) errors.push(`dossier : "${c.folder}" inconnu (${Object.keys(TYPES).join(', ')})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) errors.push('nom : kebab-case ASCII attendu');
  const text = readText(c.abs);
  const parts = split(text);
  if (!parts) return { errors: [...errors, 'frontmatter : absent'], warnings };
  const { fm } = parts;
  const type = TYPES[c.folder];
  if (type && fm.type !== type) errors.push(`type : "${fm.type ?? ''}" ne correspond pas au dossier (attendu ${type})`);
  if (!fm.title) errors.push('frontmatter : title manquant');
  for (const key of DATES[type] ?? []) if (!fm[key]) errors.push(`frontmatter : ${key} manquant`);
  const org = checkOrg(c.domain, fm, parts.head, errors, warnings);
  if (type === 'source') {
    if (!fm.raw) errors.push('provenance : une source cite son brut (raw: <chemin relatif a raw/<domaine>/>)');
    else if (!existsSync(path.join(VAULT, 'raw', c.domain, fm.raw))) errors.push(`provenance : raw/${c.domain}/${fm.raw} n'existe pas`);
    // Raccourci pour l'existant : une page deja dans le wiki (heritee, bronze -> or) n'a pas de fiche argent.
    // Toute NOUVELLE source doit passer par silver/<domaine>/<slug>.md (classee, nettoyee, drapeaux poses).
    const legacy = existsSync(path.join(VAULT, 'wiki', c.domain, c.folder, c.name));
    if (!legacy && !existsSync(silverPath(c))) {
      errors.push(`argent : silver/${c.domain}/${c.slug}.md manquant (une nouvelle source passe par l'argent avant l'or)`);
    }
    // La fiche argent est versionnee et censee etre « nettoyee » : elle est controlee comme le reste.
    if (existsSync(silverPath(c))) {
      const silverText = readText(silverPath(c));
      const silver = split(silverText);
      if (!silver) errors.push('argent : la fiche n\'a pas de frontmatter');
      else {
        if (silver.fm.domain !== c.domain) errors.push(`argent : domain "${silver.fm.domain ?? ''}" different de ${c.domain}`);
        if (silver.fm.raw && silver.fm.raw !== fm.raw) errors.push('argent : raw de la fiche different de celui de la page source');
        const silverOrg = parseOrgList(silver.fm.org);
        if (org && silverOrg && !sameOrgSet(org, silverOrg)) errors.push(`argent : org de la fiche (${silver.fm.org}) different de celui de la page source (${fm.org})`);
      }
      if (SECRETS.some((r) => r.test(silverText))) errors.push('secret : motif de secret detecte dans la fiche argent');
      if (others && new RegExp(`\\[\\[(${others})/`).test(silverText)) errors.push('domaine-lien : la fiche argent renvoie vers un autre domaine');
      if (LEXIQUE.test(silverText)) warnings.push('lexique : un terme du pre-filtre figure dans la fiche argent — a examiner par le relecteur');
    }
  }
  if (/\[[^\]]*\]\((?!https?:\/\/|mailto:)[^)]+\)/.test(text)) errors.push('lien-markdown : utiliser des [[wikilinks]]');
  if (SECRETS.some((r) => r.test(text))) errors.push('secret : motif de secret detecte');
  if (others) {
    const hit = text.match(new RegExp(`\\[\\[(${others})/`)) ?? text.match(new RegExp(`\\b(?:raw|silver|wiki)/(${others})(?![\\w-])`));
    if (hit) errors.push(`domaine-lien : la page renvoie vers le domaine ${hit[1]}`);
  }
  if (LEXIQUE.test(text)) warnings.push('lexique : un terme du pre-filtre figure dans la page — a examiner par le relecteur');
  return { errors, warnings };
};

const verdictFile = (hash) => path.join(VAULT, '.verdicts', `${hash}.json`);

/** L'empreinte du verdict : la candidate, et pour une source, sa fiche argent (modifier l'une annule le verdict). */
const hashOf = (c) => sha(`${readText(c.abs)}\u0000${c.folder === 'sources' && existsSync(silverPath(c)) ? readText(silverPath(c)) : ''}`);

// org-tag: (trace de vault.mjs tag-org) part avec gate: : une page qui repasse la gate tient son org: de la gate,
// et tag-org ne doit plus pouvoir le remplacer.
const stripGate = (head) => head.split('\n').filter((l) => !/^(gate|org-tag|raw-tag):/.test(l)).join('\n');

const writeText = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

const cmdCheck = (files) => {
  let bad = 0;
  for (const f of files) {
    const c = load(f);
    const { errors, warnings } = check(c);
    const label = path.relative(VAULT, c.abs);
    if (errors.length) {
      bad++;
      console.log(`refusee  ${label}`);
      for (const e of errors) console.log(`  - ${e}`);
    } else console.log(`conforme ${label}`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  return bad ? 1 : 0;
};

// Un relecteur generique (agent reviewer) applique le socle puis les regles du domaine de la page
// (domains/<domaine>/rules.md) ; le verdict dit pour quel domaine il a juge. C'est une declaration, pas une
// authentification : elle rend visible un mauvais aiguillage (verdict « perso » sur une page pro) au lieu de
// laisser passer la page avec les regles d'un autre domaine. La garde, elle, ne lui ouvre que les regles du
// domaine de la session.
const cmdVerdict = (args) => {
  const at = args.indexOf('--relecteur');
  const relecteur = at >= 0 ? args[at + 1] : undefined;
  const [file, verdict, code, ...note] = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  if (!file || !['ok', 'hold'].includes(verdict) || (verdict === 'hold' && !code) || !DOMAINS.includes(relecteur)) {
    console.log(`usage : verdict <candidate> ok --relecteur <${DOMAIN_LIST}> | verdict <candidate> hold <code> [note] --relecteur <${DOMAIN_LIST}>`);
    return 1;
  }
  const c = load(file);
  if (c.error || !c.exists) return console.log('candidate introuvable ou hors .candidats/wiki/'), 1;
  if (relecteur !== c.domain) {
    console.log(`refuse : un verdict ${relecteur} ne vaut pas pour une page ${c.domain} (relancer l'agent reviewer depuis une session ${c.domain})`);
    return 1;
  }
  const hash = hashOf(c);
  mkdirSync(path.join(VAULT, '.verdicts'), { recursive: true });
  writeFileSync(
    verdictFile(hash),
    JSON.stringify({ verdict, code: code ?? null, note: note.join(' ') || null, file: path.relative(VAULT, c.abs), at: today(), rules: RULES, relecteur }, null, 2),
  );
  console.log(`verdict ${verdict}${code ? ` (${code})` : ''} du relecteur ${relecteur} enregistre pour ${path.relative(VAULT, c.abs)} [${hash.slice(0, 8)}]`);
  return 0;
};

const quarantine = (c, hash, verdict) => {
  const base = path.join(VAULT, 'quarantine', c.domain, `${c.folder}-${c.slug}`);
  writeText(`${base}.md`, readText(c.abs));
  writeText(
    `${base}.json`,
    JSON.stringify({ code: verdict.code, note: verdict.note, target: `wiki/${c.domain}/${c.folder}/${c.name}`, at: today(), hash }, null, 2),
  );
  rmSync(c.abs);
  return path.relative(VAULT, `${base}.md`);
};

const cmdPromote = (files) => {
  let worst = 0;
  for (const f of files) {
    const c = load(f);
    const label = path.relative(VAULT, c.abs);
    const { errors } = check(c);
    if (errors.length) {
      console.log(`refusee  ${label} : ${errors.join(' ; ')}`);
      worst = Math.max(worst, 1);
      continue;
    }
    const text = readText(c.abs);
    const hash = hashOf(c);
    if (!existsSync(verdictFile(hash))) {
      console.log(`sans verdict ${label} : aucun relecteur n'a juge cette version exacte (toute modification annule le verdict)`);
      worst = Math.max(worst, 3);
      continue;
    }
    const verdict = JSON.parse(readFileSync(verdictFile(hash), 'utf8'));
    // Un verdict sans relecteur de domaine (anterieur au decoupage) ou d'un autre domaine ne vaut rien.
    if (verdict.relecteur !== c.domain) {
      console.log(`sans verdict ${label} : le verdict n'a pas ete rendu pour le domaine ${c.domain} (relancer l'agent reviewer depuis une session ${c.domain})`);
      worst = Math.max(worst, 3);
      continue;
    }
    if (verdict.verdict !== 'ok') {
      console.log(`retenue  ${label} -> ${quarantine(c, hash, verdict)} (code ${verdict.code}) : ne pas la reecrire, l'utilisateur decide`);
      worst = Math.max(worst, 4);
      continue;
    }
    const { head, body } = split(text);
    const out = `---\ngate: passe ${today()} juge=relecteur regles=${RULES}\n${stripGate(head)}\n---\n${body}`;
    const target = path.join(VAULT, 'wiki', c.domain, c.folder, c.name);
    writeText(target, out);
    rmSync(c.abs);
    console.log(`admise   ${path.relative(VAULT, target)}`);
  }
  return worst;
};

const cmdQuarantine = ([domain, slug, code, raw, ...note]) => {
  if (!DOMAINS.includes(domain) || !slug || !code || !raw) {
    console.log(`usage : quarantine <${DOMAIN_LIST}> <slug> <code> <chemin-raw> [note sans citation]`);
    return 1;
  }
  const base = path.join(VAULT, 'quarantine', domain, `source-${slug}`);
  writeText(`${base}.json`, JSON.stringify({ code, note: note.join(' ') || null, raw, at: today(), pointeur: true }, null, 2));
  console.log(`consigne ${path.relative(VAULT, base)}.json (pointeur vers le brut, aucun texte copie)`);
  return 0;
};

/**
 * Nature d'un element de quarantaine, et ce que `decide` en accepte. Une seule regle, celle de `decide` :
 *   pointeur  pas de target (cmdQuarantine)          -> drop seulement (classer sans suite ; aucune page touchee)
 *   retenue   target + <base>.md present (promote)   -> keep | correct | drop (drop supprime la page retenue)
 *   signalee  target, pas de .md (cmdFlag)           -> keep | correct | drop (drop sort la page du wiki)
 * Le critere est la presence du .md, pas le marqueur `flagged` ni `pointeur` : decide ne lit pas ces marqueurs.
 * Recopie conforme dans tools/dashboard/held-read.mjs (le dashboard n'importe pas hooks/) ; un test compare les deux.
 */
const kindOf = (base, meta) => (!meta.target ? 'pointeur' : existsSync(`${base}.md`) ? 'retenue' : 'signalee');
const ACTIONS = { pointeur: ['drop'], retenue: ['keep', 'correct', 'drop'], signalee: ['keep', 'correct', 'drop'] };

const cmdUndecided = ([domain]) => {
  if (domain && !DOMAINS.includes(domain)) return console.log(`usage : undecided [${DOMAIN_LIST}]`), 1;
  const list = domain ? [domain] : DOMAINS;
  let n = 0;
  for (const d of list) {
    const dir = path.join(VAULT, 'quarantine', d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const meta = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const kind = kindOf(path.join(dir, f.slice(0, -5)), meta);
      console.log(`${d}/${f.slice(0, -5)}  nature=${kind}  code=${meta.code}  date=${meta.at}  ${meta.target ?? meta.raw ?? ''}  [${ACTIONS[kind].join('|')}]`);
      n++;
    }
  }
  if (!n) console.log('rien en attente de decision');
  return 0;
};

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []))
    : [];

/** Anomalies deterministes du wiki d'un domaine. Le lint y ajoute ce qui demande de lire (contradictions, claims perimees). */
// Sans argument : le premier domaine declare (ici, comme avant, pro).
const cmdAudit = ([domain = DOMAINS[0]]) => {
  if (!DOMAINS.includes(domain)) return console.log(`usage : audit <${DOMAIN_LIST}>`), 1;
  const root = path.join(VAULT, 'wiki', domain);
  const otherPrefix = CFG.others(domain).map((o) => `${o}/`);
  const pages = new Map(); // "folder/slug" -> chemin
  for (const f of walk(root)) {
    const rel = path.relative(root, f).split(path.sep);
    if (rel.length === 2 && TYPES[rel[0]]) pages.set(`${rel[0]}/${rel[1].slice(0, -3)}`, f);
  }
  const catalog = ['index', 'log', 'overview'];
  const issues = { frontmatter: [], 'type-dossier': [], 'lien-casse': [], orphelines: [], 'domaine-lien': [], 'hors-index': [], 'index-fantome': [] };
  const inbound = new Map([...pages.keys()].map((k) => [k, 0]));
  let legacy = 0;
  const missing = new Map(); // cible manquante -> pages qui la citent (lien casse ou lacune, cf. CLAUDE.md §5.3)
  const read = new Map(); // "folder/slug" -> { text, fm }
  // [^\[\]|#] : les [[[a]], [[b]]] du frontmatter ; le \ final vient des \| des tableaux Markdown.
  const links = (text) => [...text.matchAll(/\[\[([^\[\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim().replace(/\\$/, '').replace(/\.md$/, ''));
  for (const [key, file] of pages) {
    const text = readText(file);
    const parts = split(text);
    read.set(key, { text, fm: parts?.fm ?? {} });
    if (!parts) issues.frontmatter.push(key);
    else {
      const [folder] = key.split('/');
      if (parts.fm.type !== TYPES[folder]) issues['type-dossier'].push(`${key} (type=${parts.fm.type ?? '?'})`);
      if (!parts.fm.gate) legacy++;
    }
    for (const t of links(text)) {
      if (otherPrefix.some((p) => t.startsWith(p))) issues['domaine-lien'].push(`${key} -> ${t}`);
      else if (pages.has(t)) inbound.set(t, (inbound.get(t) ?? 0) + (t === key ? 0 : 1));
      else if (!catalog.includes(t) && !/^(raw|silver)\//.test(t)) missing.set(t, (missing.get(t) ?? new Set()).add(key));
    }
  }
  // Lien casse ou lacune (CLAUDE.md §5.3) : on juge chaque cible une fois, par sources distinctes.
  // Une page source est sa propre source ; les autres renvoient a la source citee sur la ligne,
  // sinon a l'unique source de leur `sources:` (une paire source + meeting n'en fait qu'une) ;
  // provenance indecidable : la page compte pour elle-meme. Meme regle que tools/dashboard/vault-read.mjs.
  const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const byName = new Map();
  for (const [key, { fm }] of read) {
    const aliases = String(fm.aliases ?? '').replace(/^\[|\]$/g, '').split(',').map((a) => a.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    for (const name of [key.split('/')[1], slugify(fm.title?.replace(/^["']|["']$/g, '') ?? ''), ...aliases.map(slugify)]) if (name && !byName.has(name)) byName.set(name, key);
  }
  const sourcesOfLine = (key, line) => {
    if (key.startsWith('sources/')) return [key];
    const inline = links(line).filter((l) => l.startsWith('sources/'));
    if (inline.length) return inline;
    // `sources:` en wikilinks ou en chemins bruts (forme du domaine perso)
    const raw = String(read.get(key).fm.sources ?? '');
    const declared = (links(raw).length ? links(raw) : raw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '').replace(/\.md$/, '')))
      .filter((l) => l.startsWith('sources/'));
    return declared.length === 1 ? declared : [key];
  };
  const lacunes = [];
  for (const [t, citedBy] of [...missing].sort((a, b) => b[1].size - a[1].size)) {
    const sources = new Set();
    for (const key of citedBy) {
      for (const line of read.get(key).text.split('\n')) if (links(line).includes(t)) for (const s of sourcesOfLine(key, line)) if (s !== t) sources.add(s);
    }
    const existing = byName.get(t.split('/').pop());
    if (existing) issues['lien-casse'].push(`${t} : la page existe sous [[${existing}]] (cite par ${[...citedBy].join(', ')})`);
    else if (sources.size >= 2) issues['lien-casse'].push(`${t} : cite par ${sources.size} sources (${[...sources].join(', ')})`);
    else lacunes.push(`${t} (${[...sources].join(', ')})`);
  }
  for (const [key, n] of inbound) if (n === 0) issues.orphelines.push(key);
  // org: (CLAUDE.md §6, domaines a extension org) : page sans org:, et page derivee dont org: n'est pas l'union de ses
  // sources. Une source citee introuvable ou sans org: est ignoree dans l'union (org-absent la signale deja).
  if (registryOf(domain)) {
    issues['org-absent'] = [];
    issues['org-union'] = [];
    for (const [key, { fm }] of read) {
      const [folder] = key.split('/');
      const own = parseOrgList(fm.org);
      if (!own) {
        issues['org-absent'].push(key);
        continue;
      }
      if (folder === 'sources') continue;
      const union = [...new Set(citedSources(fm, TYPES[folder]).flatMap((s) => parseOrgList(read.get(s)?.fm.org) ?? []))];
      if (union.length && !sameOrgSet(own, union)) issues['org-union'].push(`${key} : ${formatOrgList(own)} -> ${formatOrgList(union)}`);
    }
  }
  const indexFile = path.join(root, 'index.md');
  if (existsSync(indexFile)) {
    const indexed = new Set(links(readText(indexFile)));
    for (const key of pages.keys()) if (!indexed.has(key)) issues['hors-index'].push(key);
    for (const t of indexed) if (/^[a-z]+\/[a-z0-9-]+$/.test(t) && TYPES[t.split('/')[0]] && t.split('/')[1] !== 'slug' && !pages.has(t)) issues['index-fantome'].push(t);
  } else issues['hors-index'].push('(index.md absent)');
  console.log(`wiki/${domain} : ${pages.size} pages, ${legacy} heritees (sans ligne gate:), ${pages.size - legacy} admises par la gate`);
  for (const [name, list] of Object.entries(issues)) {
    console.log(`${name} : ${list.length}`);
    for (const x of list.slice(0, 40)) console.log(`  - ${x}`);
    if (list.length > 40) console.log(`  … et ${list.length - 40} autres`);
  }
  // Hors anomalies : une lacune voulue n'est pas une dette (CLAUDE.md §5.3)
  console.log(`lacunes (informatif, §5.3) : ${lacunes.length}`);
  for (const x of lacunes.slice(0, 40)) console.log(`  - ${x}`);
  if (lacunes.length > 40) console.log(`  … et ${lacunes.length - 40} autres`);
  return 0;
};

/** Signaler une page deja dans le wiki (ancien fonds) : elle ne bouge pas, elle rejoint « a decider ». */
const cmdFlag = ([domain, target, code, ...note]) => {
  if (!DOMAINS.includes(domain) || !target || !code) return console.log(`usage : flag <${DOMAIN_LIST}> <folder/slug> <code> [note sans citation]`), 1;
  const [folder, slug] = target.replace(/\.md$/, '').split('/');
  if (!TYPES[folder] || !slug || !existsSync(path.join(VAULT, 'wiki', domain, folder, `${slug}.md`))) return console.log(`page inconnue : wiki/${domain}/${target}`), 1;
  writeText(
    path.join(VAULT, 'quarantine', domain, `${folder}-${slug}.json`),
    JSON.stringify({ code, note: note.join(' ') || null, target: `wiki/${domain}/${folder}/${slug}.md`, at: today(), flagged: true }, null, 2),
  );
  console.log(`signalee ${domain}/${folder}-${slug} (code ${code}) — la page reste en place jusqu'a decision`);
  return 0;
};

/**
 * Copie une page de l'or sous .candidats/ pour la modifier : la garde refuse `cp wiki/... .candidats/...` (elle voit
 * « wiki/ » dans une commande qui ecrit), et reecrire une longue page a la main la fait deriver sans bruit.
 * Copie a l'octet pres, ligne gate: retiree (promote la repose). Aucun droit de plus : la candidate repasse
 * check, relecteur, promote. Session ingest de son domaine seulement : la garde ne lit pas les arguments de
 * vault.mjs, c'est ce controle qui tient le silo ici (une declaration, pas une authentification).
 */
const cmdStage = ([domain, ...targets]) => {
  if (!DOMAINS.includes(domain) || !targets.length) return console.log(`usage : stage <${DOMAIN_LIST}> <dossier/slug>...`), 1;
  if (process.env.VAULT_MODE !== 'ingest') return console.log(`stage : session ingest seulement (VAULT_MODE="${process.env.VAULT_MODE ?? ''}")`), 1;
  if (process.env.VAULT_DOMAIN !== domain) return console.log(`stage : la session est ${process.env.VAULT_DOMAIN ?? '(sans domaine)'}, pas ${domain}`), 1;
  let worst = 0;
  for (const t of targets) {
    const [folder, slug, ...rest] = t.replace(/\.md$/, '').split('/');
    const refuse = (why) => (console.log(`refusee  ${domain}/${t} : ${why}`), (worst = 1));
    if (!TYPES[folder] || !slug || rest.length) {
      refuse(`dossier/slug attendu, dossier parmi ${Object.keys(TYPES).join(', ')} (index, log et overview s'editent en place)`);
      continue;
    }
    // Avant « page absente » : une page signalee ou retenue attend l'utilisateur, quel que soit l'etat de l'or.
    if (existsSync(path.join(VAULT, 'quarantine', domain, `${folder}-${slug}.json`))) {
      refuse(`en attente de decision (quarantine/${domain}/${folder}-${slug}) : passer par decide ... correct`);
      continue;
    }
    const source = path.join(VAULT, 'wiki', domain, folder, `${slug}.md`);
    if (!existsSync(source)) {
      refuse('absente du wiki : une nouvelle page s\'ecrit directement sous .candidats/');
      continue;
    }
    const target = path.join(VAULT, '.candidats', 'wiki', domain, folder, `${slug}.md`);
    if (existsSync(target)) {
      refuse(`candidate deja presente (${path.relative(VAULT, target)}) : un brouillon ne s'ecrase pas`);
      continue;
    }
    // Lu tel quel (sans normaliser les fins de ligne) : seules les lignes gate: et org-tag: du frontmatter disparaissent.
    const text = readFileSync(source, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const out = fm ? `${text.slice(0, fm.index)}${text.slice(fm.index, fm.index + fm[0].length).replace(/^gate:.*\r?\n/m, '').replace(/^org-tag:.*\r?\n/m, '').replace(/^raw-tag:.*\r?\n/m, '')}${text.slice(fm.index + fm[0].length)}` : text;
    writeText(target, out);
    console.log(`a modifier ${path.relative(VAULT, target)} (puis check, agent reviewer en session ${domain}, promote)`);
  }
  return worst;
};

/**
 * La decision de l'utilisateur sur un element de quarantaine. A n'appeler qu'apres une decision EXPLICITE
 * de sa part dans la conversation.
 *   keep     : retenue -> admise telle quelle (juge=utilisateur) ; signalee -> le drapeau est leve
 *   correct  : retenue -> retourne sous .candidats/ pour reecriture (repasse check + relecteur) ;
 *              signalee -> copie sous .candidats/ pour correction
 *   drop     : retenue -> supprimee ; signalee -> la page sort du wiki (copie recuperable dans quarantine/<d>/sortis/)
 */
const cmdDecide = ([domain, name, action, ...note]) => {
  if (!DOMAINS.includes(domain) || !name || !['keep', 'correct', 'drop'].includes(action)) {
    return console.log(`usage : decide <${DOMAIN_LIST}> <folder-slug> keep|correct|drop [note]`), 1;
  }
  const base = path.join(VAULT, 'quarantine', domain, name);
  if (!existsSync(`${base}.json`)) return console.log(`introuvable : quarantine/${domain}/${name}.json (voir undecided)`), 1;
  const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const kind = kindOf(base, meta);
  const held = kind === 'retenue';
  const target = meta.target ? path.join(VAULT, meta.target) : null;
  const candidate = meta.target ? path.join(VAULT, '.candidats', meta.target) : null;
  const journal = (fait) =>
    writeFileSync(path.join(VAULT, 'quarantine', domain, 'decisions.jsonl'), `${JSON.stringify({ name, action, code: meta.code, note: note.join(' ') || null, at: today(), fait })}\n`, { flag: 'a' });
  if (kind === 'pointeur') {
    // pointeur vers une source ecartee : seul « drop » (classer sans suite) a un sens
    if (!ACTIONS.pointeur.includes(action)) return console.log('un pointeur de source ecartee ne se promeut pas : reingerer la source si besoin, ou drop'), 1;
    rmSync(`${base}.json`);
    journal('pointeur clos');
    return console.log('pointeur clos'), 0;
  }
  if (action === 'keep') {
    if (held) {
      const { head, body } = split(readText(`${base}.md`));
      writeText(target, `---\ngate: passe ${today()} juge=utilisateur regles=${RULES}\n${stripGate(head)}\n---\n${body}`);
      rmSync(`${base}.md`);
      journal('page admise sur decision de l\'utilisateur');
    } else journal('drapeau leve, page inchangee');
    rmSync(`${base}.json`);
    return console.log(held ? `admise ${meta.target} (juge=utilisateur)` : 'drapeau leve'), 0;
  }
  if (action === 'correct') {
    writeText(candidate, held ? readText(`${base}.md`) : readText(target));
    if (held) rmSync(`${base}.md`);
    rmSync(`${base}.json`);
    journal('renvoyee sous .candidats/ pour correction');
    return console.log(`a corriger : ${path.relative(VAULT, candidate)} (puis check, relecteur, promote)`), 0;
  }
  if (held) rmSync(`${base}.md`);
  else if (existsSync(target)) {
    writeText(path.join(VAULT, 'quarantine', domain, 'sortis', path.basename(target)), readText(target));
    rmSync(target);
    // « sortir du coffre » vaut aussi pour la copie d'instantane (silver/<d>/heritage/) : pas de double vie.
    rmSync(path.join(VAULT, 'silver', domain, 'heritage', path.relative(path.join(VAULT, 'wiki', domain), target)), { force: true });
  }
  rmSync(`${base}.json`);
  journal(held ? 'page supprimee' : 'page sortie du wiki (copie dans sortis/)');
  console.log(held ? 'supprimee' : `sortie du wiki (copie recuperable : quarantine/${domain}/sortis/). Liens entrants a nettoyer : relancer audit.`);
  return 0;
};

/**
 * Amorcage : copie l'or existant dans silver/<domaine>/heritage/ comme instantane date (l'historique de depart).
 * Une seule fois, jamais d'ecrasement. Ensuite l'instantane est FERME (la garde le refuse en lecture et en
 * ecriture, dans tous les modes) : les lectures et les ingestions suivantes ne lisent que l'or.
 */
const cmdSeed = ([domain]) => {
  if (!DOMAINS.includes(domain)) return console.log(`usage : seed <${DOMAIN_LIST}>`), 1;
  const dest = path.join(VAULT, 'silver', domain, 'heritage');
  const marker = path.join(dest, '_seed.json');
  if (existsSync(marker)) return console.log(`deja amorce (${path.relative(VAULT, marker)}) : un instantane ne s'ecrase pas`), 1;
  let n = 0;
  const byFolder = {};
  for (const folder of Object.keys(TYPES)) {
    for (const f of walk(path.join(VAULT, 'wiki', domain, folder))) {
      const target = path.join(dest, path.relative(path.join(VAULT, 'wiki', domain), f));
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(f, target);
      byFolder[folder] = (byFolder[folder] ?? 0) + 1;
      n++;
    }
  }
  if (!n) return console.log(`rien a amorcer : wiki/${domain} n'a aucune page`), 0;
  writeText(marker, JSON.stringify({ at: today(), domain, count: n, byFolder, source: `wiki/${domain}`, note: 'instantane de depart, ferme : on lit l\'or, pas cette copie' }, null, 2));
  console.log(`amorce : ${n} pages copiees dans ${path.relative(VAULT, dest)}/ (${Object.entries(byFolder).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  return 0;
};

/** Ecrit a cote puis renomme : un arret brutal laisse l'ancien fichier ou le nouveau, jamais un fichier tronque. */
const writeAtomic = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text, 'utf8');
  renameSync(`${file}.tmp`, file);
};

/**
 * Rotation du journal : wiki/<D>/log.md ne garde que le mois courant (date systeme), chaque mois revolu
 * part dans wiki/<D>/log/<AAAA-MM>.md. Motif : le journal pro depassait le plafond de lecture (445 Ko pour
 * 256), alors que chaque session n'en lit que la fin. Les entrees sont deplacees telles quelles, dans leur
 * ordre ; l'en-tete de log.md reste. Ordre d'ecriture : archives d'abord, log.md ensuite. Un arret entre les
 * deux duplique des entrees au lieu d'en perdre, et la relance ne les rajoute pas (une entree deja presente
 * dans son archive n'y est pas recopiee).
 * Verrou du circuit Plaud pris pendant l'ecriture. Limite, dite : une session ingest manuelle ne le prend
 * pas, une rotation lancee pendant qu'elle ecrit le journal pourrait lui faire perdre son entree.
 */
const cmdRotateLog = async (args) => {
  const dry = args.includes('--dry-run');
  const [domain] = args.filter((a) => a !== '--dry-run');
  if (!DOMAINS.includes(domain)) return console.log(`usage : rotate-log <${DOMAIN_LIST}> [--dry-run]`), 1;
  if (!['query', 'ingest'].includes(process.env.VAULT_MODE)) return console.log(`rotate-log : session query ou ingest seulement (VAULT_MODE="${process.env.VAULT_MODE ?? ''}")`), 1;
  if (process.env.VAULT_DOMAIN !== domain) return console.log(`rotate-log : la session est ${process.env.VAULT_DOMAIN ?? '(sans domaine)'}, pas ${domain}`), 1;
  const file = path.join(VAULT, 'wiki', domain, 'log.md');
  if (!existsSync(file)) return console.log(`rien a archiver : wiki/${domain}/log.md absent`), 0;

  const original = readFileSync(file, 'utf8');
  const text = original.endsWith('\n') ? original : `${original}\n`; // une derniere entree sans saut de ligne en recoit un
  const head = [];
  const entries = []; // { month, chunk }
  for (const line of text.split(/(?<=\n)/)) {
    const m = line.match(/^## \[(\d{4}-\d{2})-\d{2}/);
    if (m) entries.push({ month: m[1], chunk: line });
    else if (entries.length) entries[entries.length - 1].chunk += line;
    else head.push(line);
  }
  const current = today().slice(0, 7);
  const kept = entries.filter((e) => e.month >= current);
  const moved = entries.filter((e) => e.month < current);
  if (!moved.length) return console.log(`rien a archiver : wiki/${domain}/log.md ne contient que ${current}`), 0;

  // Controle d'integrite avant toute ecriture : chaque octet du journal est soit garde, soit archive.
  const total = head.join('').length + entries.reduce((n, e) => n + e.chunk.length, 0);
  if (total !== text.length || kept.length + moved.length !== entries.length) {
    return console.log('rotate-log : decoupage incoherent, rien n\'est ecrit (signale-le)'), 1;
  }

  const byMonth = new Map();
  for (const e of moved) byMonth.set(e.month, [...(byMonth.get(e.month) ?? []), e.chunk]);
  const plan = [...byMonth].map(([month, chunks]) => {
    const archive = path.join(VAULT, 'wiki', domain, 'log', `${month}.md`);
    const before = existsSync(archive) ? readFileSync(archive, 'utf8') : `---\ntype: log\ntitle: "Journal ${domain} — ${month}"\n---\n\n`;
    // Par occurrences, pas par presence : deux entrees identiques du meme mois (meme question, meme minute)
    // restent deux. Seules les occurrences deja dans l'archive (reprise apres arret) ne sont pas recopiees.
    const occurrences = (hay, needle) => hay.split(needle).length - 1;
    const seen = new Map();
    const fresh = chunks.filter((c) => {
      seen.set(c, (seen.get(c) ?? 0) + 1);
      return seen.get(c) > occurrences(before, c);
    });
    const sep = before.endsWith('\n') ? '' : '\n';
    return { month, archive, count: chunks.length, fresh, after: fresh.length ? `${before}${sep}${fresh.join('')}` : before };
  });
  const rest = `${head.join('')}${kept.map((e) => e.chunk).join('')}`;
  for (const p of plan) console.log(`${dry ? '[dry-run] ' : ''}${p.month} : ${p.count} entree(s) -> ${path.relative(VAULT, p.archive)}${p.fresh.length < p.count ? ` (${p.count - p.fresh.length} deja presente(s))` : ''}`);
  console.log(`${dry ? '[dry-run] ' : ''}log.md garde ${kept.length} entree(s) de ${current} (${Math.round(Buffer.byteLength(original) / 1024)} Ko -> ${Math.round(Buffer.byteLength(rest) / 1024)} Ko)`);
  if (dry) return 0;

  // Import a la demande : la gate (check, promote...) ne doit pas dependre de tools/ pour fonctionner.
  const { acquire, holderText, release } = await import('../tools/connectors/lock.mjs');
  const lock = acquire(VAULT, { owner: 'kioku rotate-log' });
  if (!lock.ok) return console.log(`rotate-log : ${holderText(lock.held)}, relance apres`), 1;
  try {
    // Le journal a-t-il bouge depuis la lecture ? Une entree ajoutee entre-temps serait perdue.
    if (readFileSync(file, 'utf8') !== original) return console.log('rotate-log : log.md a change pendant la rotation, rien n\'est ecrit, relance'), 1;
    for (const p of plan) if (p.fresh.length) writeAtomic(p.archive, p.after);
    writeAtomic(file, rest);
  } finally {
    release(VAULT);
  }
  return 0;
};

/**
 * Migration de l'attribut org: (CLAUDE.md §6) sur l'or pro existant, en deux tours (plan pro-org-structure, KTD5-7).
 * Tour `sources` : les pages sources/, classees sur des signaux de leur propre texte.
 * Tour `derivees` : tout le reste, union des org: REELLEMENT poses sur les sources citees (apres le tour 1),
 * pour qu'une correction de l'utilisateur sur une source se propage aux pages qui la citent.
 * La sortie est un TSV chemin<TAB>org<TAB>raison, sans aucun contenu de page ; l'utilisateur remplace les `?`.
 */
const wikiLinks = (value) => [...String(value ?? '').matchAll(/\[\[([^\[\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim().replace(/\.md$/, ''));

/** Les sources citees en frontmatter : `sources:`, plus `derived_from:` pour une synthese (5 des 6 n'ont que lui). */
const citedSources = (fm, type) =>
  [...new Set([...wikiLinks(fm.sources), ...(type === 'synthesis' ? wikiLinks(fm.derived_from) : [])].filter((l) => l.startsWith('sources/')))];

const domainPages = (domain) => {
  const root = path.join(VAULT, 'wiki', domain);
  const pages = new Map(); // "folder/slug" -> { file, text, parts }
  for (const folder of Object.keys(TYPES)) {
    const dir = path.join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      const file = path.join(dir, name);
      const text = readText(file);
      pages.set(`${folder}/${name.slice(0, -3)}`, { file, text, parts: split(text) });
    }
  }
  return pages;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Un nom du registre en regex : apostrophe droite ou typographique indifferemment.
const nameRe = (s) => escapeRe(s).replace(/['’]/g, "['’]");

/** Les domaines a extension org : propose-org, tag-org, propose-raw et tag-raw ne valent que pour eux. */
const ORG_DOMAINS = DOMAINS.filter((d) => registryOf(d));

const cmdProposeOrg = (args) => {
  const at = args.indexOf('--tour');
  const tour = at >= 0 ? args[at + 1] : undefined;
  const domain = args[0];
  if (!ORG_DOMAINS.includes(domain) || !['sources', 'derivees'].includes(tour)) {
    return console.log(`usage : propose-org <${ORG_DOMAINS.join('|')}> --tour sources|derivees  (TSV sur la sortie standard)`), 1;
  }
  const reg = loadRegistry(domain);
  const employer = reg.orgs.find((o) => o.id === reg.employer);
  const pages = domainPages(domain);
  // Marques historiques d'une source de l'employeur : le callout « … hors <client> » et le tag `hors-<client>`.
  // Construits sur les clients du registre, pour ne porter aucun nom dans le code.
  const clientNames = reg.clients.flatMap((o) => [o.name, ...o.aliases]).map(nameRe);
  const callout = clientNames.length ? new RegExp(`^>.*hors (${clientNames.join('|')})`, 'im') : null;
  const horsTags = new Set(reg.clients.map((o) => `hors-${o.id}`));
  const employerCited = new RegExp(`\\b(${[employer.name, ...employer.aliases].map(escapeRe).join('|')})\\b`, 'i');
  const rows = [];
  for (const [key, { parts }] of pages) {
    if (!parts || /^org:/m.test(parts.head)) continue; // deja taguee, ou sans frontmatter (signalee par audit)
    const [folder] = key.split('/');
    const isSource = folder === 'sources';
    if ((tour === 'sources') !== isSource) continue;
    if (isSource) {
      const tags = parseOrgList(parts.fm.tags) ?? [];
      // Le tag de l'employeur seul ne suffit pas : il figure aussi sur des sources client mixtes (passation, recrutement).
      if (callout?.test(parts.body)) rows.push([key, reg.employer, 'callout']);
      else if (tags.some((t) => horsTags.has(t))) rows.push([key, reg.employer, 'tag']);
      else if (tags.includes(reg.employer) || employerCited.test(parts.body)) rows.push([key, '?', 'employeur-cite']);
      else if (reg.active.length === 1) rows.push([key, reg.active[0].id, 'client-actif']);
      else rows.push([key, '?', reg.active.length ? 'plusieurs-clients-actifs' : 'aucun-client-actif']);
      continue;
    }
    const cited = citedSources(parts.fm, TYPES[folder]);
    if (!cited.length) {
      rows.push([key, '?', 'sans-source']);
      continue;
    }
    const orgs = cited.map((s) => {
      const p = pages.get(s)?.parts;
      return p && /^org:/m.test(p.head) ? parseOrgList(p.fm.org) : null;
    });
    if (orgs.some((o) => !o)) rows.push([key, '?', 'source-non-taguee']);
    else rows.push([key, [...new Set(orgs.flat())].sort().join(','), 'union']);
  }
  for (const r of rows) console.log(r.join('\t'));
  const counts = rows.reduce((m, [, , why]) => m.set(why, (m.get(why) ?? 0) + 1), new Map());
  console.error(`propose-org ${tour} : ${rows.length} page(s) — ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'rien a proposer'}`);
  return 0;
};

/**
 * Applique un TSV de propose-org (relu par l'utilisateur) : n'insere ou ne remplace que `org:` et `org-tag:`,
 * juste avant la fin du frontmatter, et verifie qu'en les retirant on retrouve le fichier d'origine a l'octet.
 * Remplace un org: seulement s'il porte une trace org-tag: (pose par la migration) ; un org: pose par la gate
 * ne se touche pas ici. Refuse tant qu'une candidate du domaine attend : promue apres, elle ecraserait la page taguee.
 * Le domaine vise est celui de la session (query ou ingest, extension org), verrou commun du coffre (tools/connectors/lock.mjs) pris pendant
 * l'ecriture, comme rotate-log.
 */
const cmdTagOrg = async (args) => {
  const dry = args.includes('--dry-run');
  const [tsvFile] = args.filter((a) => a !== '--dry-run');
  if (!tsvFile) return console.log('usage : tag-org <fichier.tsv> [--dry-run]'), 1;
  const guard = tagGuard('tag-org');
  if (guard) return console.log(guard), 1;
  const domain = process.env.VAULT_DOMAIN;
  const reg = loadRegistry(domain);
  const stamp = `org-tag: ${today()} juge=utilisateur`;
  const plan = [];
  let refused = 0;
  const refuse = (key, why) => (refused++, console.log(`refusee  ${key} : ${why}`));
  for (const line of readFileSync(path.resolve(process.cwd(), tsvFile), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key, value = ''] = line.split('\t');
    const [folder, slug, ...rest] = key.split('/');
    if (!TYPES[folder] || !slug || rest.length) {
      refuse(key, 'chemin attendu : <dossier>/<slug>');
      continue;
    }
    const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length || ids.includes('?')) {
      refuse(key, 'org a trancher (?)');
      continue;
    }
    const unknown = ids.filter((id) => !reg.ids.has(id));
    if (unknown.length) {
      refuse(key, `hors registre : ${unknown.join(', ')}`);
      continue;
    }
    const file = path.join(VAULT, 'wiki', domain, folder, `${slug}.md`);
    if (!existsSync(file)) {
      refuse(key, 'page absente');
      continue;
    }
    // Une version retenue, gardee ensuite (decide keep), reecrirait la page sans son org: : on attend la decision.
    if (existsSync(path.join(VAULT, 'quarantine', domain, `${folder}-${slug}.json`))) {
      refuse(key, `en attente de decision (quarantine/${domain}/${folder}-${slug}) : trancher d'abord au lint`);
      continue;
    }
    const r = setFrontmatterField(file, 'org', formatOrgList(ids), stamp);
    if (r.error) {
      refuse(key, r.error);
      continue;
    }
    plan.push({ key, file, original: r.original, out: r.out, label: formatOrgList(ids) });
  }
  return writeTagPlan('tag-org', plan, dry, refused, refuse);
};

/**
 * Pose ou remplace UN champ du frontmatter (`<field>:`) et sa trace (`<field>-tag:`), juste avant la fin du
 * frontmatter, sans toucher au reste : relu tel quel (CRLF conserve), puis controle qu'en retirant ces deux
 * lignes on retrouve l'original a l'octet. Un champ deja present sans sa trace a ete pose par la gate : refus.
 * Rend { original, out } ou { error }.
 */
const setFrontmatterField = (file, field, value, stamp) => {
  const original = readFileSync(file, 'utf8');
  const fm = original.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fm) return { error: 'frontmatter absent ou mal forme' };
  const eol = fm[1];
  const ours = new RegExp(`^${field}(-tag)?:`);
  const lines = fm[2].split(eol);
  const has = lines.some((l) => new RegExp(`^${field}:`).test(l));
  const hasTag = lines.some((l) => new RegExp(`^${field}-tag:`).test(l));
  if (has && !hasTag) return { error: `${field}: pose par la gate (sans trace ${field}-tag:) : se corrige par stage, relecteur, promote` };
  const head = [...lines.filter((l) => !ours.test(l)), `${field}: ${value}`, stamp].join(eol);
  const start = `---${eol}`;
  const out = `${start}${head}${original.slice(start.length + fm[2].length)}`;
  // Controle d'integrite : sans nos deux lignes, on doit retrouver l'original (sans ses anciennes lignes du champ).
  const strip = (t) => t.split(eol).filter((l) => !ours.test(l)).join(eol);
  if (strip(out) !== strip(original) || out.match(/^---\r?\n[\s\S]*?\r?\n---/)[0].length !== start.length + head.length + eol.length + 3) {
    return { error: 'le reste du fichier changerait : rien n\'est ecrit (signale-le)' };
  }
  return { original, out };
};

/** Ecrit un plan de tag-org / tag-raw : dry-run, verrou commun du coffre, relecture juste avant d'ecrire, ecriture atomique. */
const writeTagPlan = async (name, plan, dry, refused, refuse) => {
  for (const p of plan) console.log(`${dry ? '[dry-run] ' : ''}taguee   ${p.key} -> ${p.label}`);
  console.log(`${dry ? '[dry-run] ' : ''}${name} : ${plan.length} page(s) a ecrire, ${refused} refusee(s)`);
  if (dry || !plan.length) return refused ? 1 : 0;
  // Import a la demande, comme rotate-log : la gate ne depend pas de tools/ hors de ces commandes.
  const { acquire, holderText, release } = await import('../tools/connectors/lock.mjs');
  const lock = acquire(VAULT, { owner: `kioku ${name}` });
  if (!lock.ok) return console.log(`${name} : ${holderText(lock.held)}, relance apres`), 1;
  let failed = refused;
  try {
    for (const p of plan) {
      if (readFileSync(p.file, 'utf8') !== p.original) {
        failed++;
        console.log(`refusee  ${p.key} : la page a change depuis la lecture, relance`);
        continue;
      }
      writeAtomic(p.file, p.out);
    }
  } finally {
    release(VAULT);
  }
  return failed ? 1 : 0;
};

/**
 * Gardes communes de tag-org / tag-raw : session query|ingest d'un domaine a extension org (le domaine vise est celui
 * de la session), aucune candidate de ce domaine en attente.
 */
const tagGuard = (name) => {
  if (!['query', 'ingest'].includes(process.env.VAULT_MODE)) return `${name} : session query ou ingest seulement (VAULT_MODE="${process.env.VAULT_MODE ?? ''}")`;
  const d = process.env.VAULT_DOMAIN;
  if (!ORG_DOMAINS.includes(d)) return `${name} : la session est ${d ?? '(sans domaine)'}, pas un domaine a extension org (${ORG_DOMAINS.join(', ') || 'aucun'})`;
  const pending = walk(path.join(VAULT, '.candidats', 'wiki', d));
  if (pending.length) return `${name} : ${pending.length} candidate(s) en attente sous .candidats/wiki/${d}/ : promouvoir ou retirer d'abord (une candidate promue apres ecraserait la page)`;
  return null;
};

/**
 * Relier le bronze herite (CLAUDE.md §3, amorcage) aux pages sources de l'or qui n'ont pas de `raw:`.
 * Ces reunions ont ete ingerees avant le medaillon, sans lien vers leur brut : le dashboard ne peut ni les compter
 * comme traitees, ni les distinguer d'un brut jamais ingere.
 * Appariement par JOURNEE (le prefixe de date est commun au brut et a la page), puis par proximite des mots du nom
 * du brut avec le slug et le titre de la page ; affectation gloutonne au meilleur score, un brut ne sert qu'une fois.
 * TSV : page<TAB>raw<TAB>score<TAB>raison ; `?` la ou rien ne s'apparie. Aucun contenu de page ni de brut lu.
 */
const STOP = new Set('le la les de des du et en au aux un une sur avec pour par a d l the and of for with in on to vs'.split(' '));
const words = (s) => new Set(String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w) || [...b].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))) n++;
  return n / Math.min(a.size, b.size);
};

const cmdProposeRaw = (args) => {
  const domain = args[0];
  if (!ORG_DOMAINS.includes(domain)) return console.log(`usage : propose-raw <${ORG_DOMAINS.join('|')}>  (TSV sur la sortie standard)`), 1;
  const rawDir = path.join(VAULT, 'raw', domain);
  const pages = domainPages(domain);
  const rawPrefix = new RegExp(`^raw/${domain}/`);
  const linked = new Set();
  const orphans = [];
  for (const [key, { parts }] of pages) {
    if (!key.startsWith('sources/') || !parts) continue;
    if (parts.fm.raw) linked.add(parts.fm.raw.replace(rawPrefix, ''));
    else orphans.push({ key, date: key.slice(8, 18), slug: key.slice(8), title: (parts.fm.title ?? '').replace(/^["']|["']$/g, '') });
  }
  // Le bronze relie a une fiche argent est deja suivi : on ne propose que le brut sans page or ni fiche argent.
  const silverDir = path.join(VAULT, 'silver', domain);
  if (existsSync(silverDir)) {
    for (const n of readdirSync(silverDir).filter((x) => x.endsWith('.md'))) {
      const s = split(readText(path.join(silverDir, n)));
      if (s?.fm.raw) linked.add(s.fm.raw.replace(rawPrefix, ''));
    }
  }
  const allRaw = existsSync(rawDir)
    ? readdirSync(rawDir, { recursive: true }).map(String).filter((f) => f.endsWith('.md')).map((f) => f.split(path.sep).join('/'))
    : [];
  const bruts = allRaw.filter((f) => !linked.has(f)).map((f) => ({ rel: f, date: path.basename(f).slice(0, 10), name: path.basename(f, '.md') }));
  const rows = [];
  const used = new Set();
  const dates = new Set([...orphans.map((o) => o.date), ...bruts.map((b) => b.date)]);
  for (const d of [...dates].sort()) {
    const ps = orphans.filter((o) => o.date === d);
    const bs = bruts.filter((b) => b.date === d);
    const pairs = [];
    for (const p of ps) {
      const pw = new Set([...words(p.slug), ...words(p.title)]);
      for (const b of bs) pairs.push({ p, b, score: overlap(words(b.name), pw) });
    }
    pairs.sort((x, y) => y.score - x.score);
    const done = new Set();
    for (const { p, b, score } of pairs) {
      if (done.has(p.key) || used.has(b.rel)) continue;
      // Une paire unique du jour passe meme a score nul (meme reunion, deux nommages) ; sinon il faut un recouvrement.
      const unique = ps.length === 1 && bs.length === 1;
      if (!unique && score < 0.25) continue;
      done.add(p.key);
      used.add(b.rel);
      rows.push([p.key, b.rel, score.toFixed(2), unique ? 'unique-du-jour' : 'meilleur-du-jour']);
    }
    for (const p of ps) if (!done.has(p.key)) rows.push([p.key, '?', '0', 'page-sans-brut']);
  }
  for (const b of bruts) if (!used.has(b.rel)) rows.push(['?', b.rel, '0', 'brut-sans-page']);
  for (const r of rows) console.log(r.join('\t'));
  const counts = rows.reduce((m, r) => m.set(r[3], (m.get(r[3]) ?? 0) + 1), new Map());
  console.error(`propose-raw : ${rows.length} ligne(s) — ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'rien a relier'}`);
  return 0;
};

/**
 * Applique un TSV de propose-raw relu : pose `raw:` (et `raw-tag:`) sur des pages sources/ du domaine de la session
 * qui n'en ont pas,
 * corps intact a l'octet (setFrontmatterField). Refuse un brut absent, un brut cite par deux lignes, une page
 * hors sources/, une page qui a deja un raw: pose par la gate, et les lignes `?`.
 */
const cmdTagRaw = async (args) => {
  const dry = args.includes('--dry-run');
  const [tsvFile] = args.filter((a) => a !== '--dry-run');
  if (!tsvFile) return console.log('usage : tag-raw <fichier.tsv> [--dry-run]'), 1;
  const guard = tagGuard('tag-raw');
  if (guard) return console.log(guard), 1;
  const domain = process.env.VAULT_DOMAIN;
  const stamp = `raw-tag: ${today()} juge=utilisateur`;
  const lines = readFileSync(path.resolve(process.cwd(), tsvFile), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
  // Doublon de brut : compte seulement parmi les lignes qui visent une page sources/ (une ligne `?` ou hors
  // sources/ sera refusee de toute facon et ne doit pas bloquer la bonne).
  const rawCount = lines
    .filter(([k, r]) => k !== '?' && r !== '?' && k.startsWith('sources/'))
    .reduce((m, [, r]) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
  const plan = [];
  let refused = 0;
  const refuse = (key, why) => (refused++, console.log(`refusee  ${key} : ${why}`));
  for (const [key, raw = ''] of lines) {
    if (key === '?' || raw === '?') {
      refuse(`${key} ${raw}`, 'ligne a trancher (?)');
      continue;
    }
    const [folder, slug, ...rest] = key.split('/');
    if (folder !== 'sources' || !slug || rest.length) {
      refuse(key, 'seule une page sources/<slug> porte un raw:');
      continue;
    }
    if (rawCount.get(raw) > 1) {
      refuse(key, `${raw} est cite par deux lignes : un brut ne relie qu'une page`);
      continue;
    }
    if (!/^[\w./-]+\.md$/.test(raw) || raw.includes('..') || !existsSync(path.join(VAULT, 'raw', domain, raw))) {
      refuse(key, `brut absent : raw/${domain}/${raw}`);
      continue;
    }
    const file = path.join(VAULT, 'wiki', domain, 'sources', `${slug}.md`);
    if (!existsSync(file)) {
      refuse(key, 'page absente');
      continue;
    }
    if (existsSync(path.join(VAULT, 'quarantine', domain, `sources-${slug}.json`))) {
      refuse(key, `en attente de decision (quarantine/${domain}/sources-${slug}) : trancher d'abord au lint`);
      continue;
    }
    const r = setFrontmatterField(file, 'raw', raw, stamp);
    if (r.error) {
      refuse(key, r.error);
      continue;
    }
    plan.push({ key, file, original: r.original, out: r.out, label: raw });
  }
  return writeTagPlan('tag-raw', plan, dry, refused, refuse);
};

/**
 * Commiter le travail d'un domaine : ce que l'ingestion, le file-back, le lint et les requetes ont ecrit.
 * Le modele n'ecrit jamais les chemins : la garde refuse un `git add` qui nomme une zone fermee (.verdicts,
 * quarantine), et la liste tapee a la main oubliait raw/ ou .verdicts. Ici, le code les calcule depuis le domaine.
 *   - session : query ou ingest de ce domaine ; dans Claude Code sans variables, le default_session (comme la garde) ;
 *     hors Claude Code (terminal), libre.
 *   - refus si une candidate attend sous .candidats/wiki/<D>/ (une ingestion inachevee ne se commite pas) ou si une
 *     nouvelle page de wiki/<D>/<dossier>/ n'a pas de gate: (ecrite hors gate).
 *   - chemins : raw/<D>, silver/<D>, wiki/<D>, quarantine/<D>, et les verdicts rendus par le relecteur de <D>.
 *   - `git commit -- <chemins>` : ce que l'utilisateur a indexe ailleurs reste indexe, hors du commit.
 *   - jamais de push (publier se decide a part, apres verification du remote prive).
 * La sortie ne cite aucun nom de page, sauf celles d'un refus : des comptes par zone et le sujet du commit.
 */
const git = (args) => spawnSync('git', ['-C', VAULT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const LOG_HEADING = /^## \[[^\]]+\][^\n]*$/gm;
const porcelain = (paths) => {
  const r = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths]);
  if (r.status !== 0) throw new Error(`git status : ${r.stderr.trim()}`);
  // -z : « XY chemin\0 » ; un renommage ou une copie ajoute « ancien\0 » apres.
  const out = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    out.push({ status, file: entry.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return out;
};
const commitSession = (domain) => {
  const envMode = process.env.VAULT_MODE;
  const envDomain = process.env.VAULT_DOMAIN;
  const session = envMode || envDomain ? { mode: envMode, domain: envDomain } : process.env.CLAUDECODE ? CFG.defaultSession : null;
  if (!session) {
    // Claude Code sans variables ni default_session : la garde refuse deja tout ; terminal : l'utilisateur est libre.
    return process.env.CLAUDECODE ? 'commit : session sans VAULT_MODE ni default_session' : null;
  }
  if (!['query', 'ingest'].includes(session.mode)) return `commit : session query ou ingest seulement (mode "${session.mode ?? ''}")`;
  if (session.domain !== domain) return `commit : la session est ${session.domain ?? '(sans domaine)'}, pas ${domain}`;
  return null;
};
const cmdCommit = (args) => {
  const at = args.indexOf('-m');
  const message = at >= 0 ? args[at + 1] : undefined;
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  const dry = rest.includes('--dry-run');
  const [domain, ...extra] = rest.filter((a) => a !== '--dry-run');
  if (!DOMAINS.includes(domain) || extra.length || (at >= 0 && !message)) {
    return console.log(`usage : commit <${DOMAIN_LIST}> [-m "<message>"] [--dry-run]`), 1;
  }
  const refused = commitSession(domain);
  if (refused) return console.log(refused), 1;
  if (git(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return console.log("commit : le coffre n'est pas un depot git"), 1;

  const pending = walk(path.join(VAULT, '.candidats', 'wiki', domain));
  if (pending.length) {
    console.log(`commit refuse : ${pending.length} candidate(s) sous .candidats/wiki/${domain}/ : finir la gate (check, relecteur, promote) avant de commiter`);
    return 1;
  }

  const zones = ['raw', 'silver', 'wiki', 'quarantine'].map((z) => `${z}/${domain}`).filter((z) => existsSync(path.join(VAULT, z)));
  const changed = zones.length ? porcelain(zones) : [];
  // Une page nouvelle de l'or sans gate: a ete ecrite hors gate (l'or herite, deja suivi, n'est pas concerne).
  const ungated = changed.filter(({ status, file }) => {
    if (!(status === '??' || status[0] === 'A')) return false;
    const rel = file.split('/');
    if (rel[0] !== 'wiki' || rel.length !== 4 || !TYPES[rel[2]] || !file.endsWith('.md')) return false;
    const abs = path.join(VAULT, file);
    return existsSync(abs) && !/^gate:/m.test(split(readText(abs)).head);
  });
  if (ungated.length) {
    console.log(`commit refuse : ${ungated.length} nouvelle(s) page(s) de wiki/${domain}/ sans gate: (ecrites hors gate) :`);
    for (const { file } of ungated) console.log(`  - ${file}`);
    return 1;
  }

  // Les verdicts du relecteur de ce domaine (avant le decoupage par domaine : ceux d'une candidate de ce domaine).
  const verdicts = existsSync(path.join(VAULT, '.verdicts'))
    ? porcelain(['.verdicts']).filter(({ status, file }) => {
        if (status.includes('D')) return false;
        try {
          const v = JSON.parse(readFileSync(path.join(VAULT, file), 'utf8'));
          return v.relecteur ? v.relecteur === domain : String(v.file ?? '').startsWith(`.candidats/wiki/${domain}/`);
        } catch {
          return false;
        }
      })
    : [];

  const files = [...changed, ...verdicts];
  if (!files.length) return console.log(`rien a commiter pour ${domain}`), 0;

  const zoneOf = (file) => file.split('/')[0];
  const counts = files.reduce((m, { file }) => m.set(zoneOf(file), (m.get(zoneOf(file)) ?? 0) + 1), new Map());
  const summary = [...counts].map(([z, n]) => `${z} ${n}`).join(', ');

  // Le message vient des entrees du journal ecrites depuis le dernier commit (absentes de log.md a HEAD).
  const logRel = `wiki/${domain}/log.md`;
  const now = existsSync(path.join(VAULT, logRel)) ? (readText(path.join(VAULT, logRel)).match(LOG_HEADING) ?? []) : [];
  const before = git(['show', `HEAD:${logRel}`]);
  const known = new Set(before.status === 0 ? (before.stdout.replace(/\r\n/g, '\n').match(LOG_HEADING) ?? []) : []);
  const entries = now.filter((h) => !known.has(h)).map((h) => h.replace(/^## /, ''));
  const typeOf = (e) => (e.match(/^\[[^\]]+\]\s*([\w-]+)/) ?? [])[1] ?? '?';
  let subject = message;
  if (!subject) {
    if (entries.length === 1) subject = `${typeOf(entries[0])}(${domain}) : ${entries[0].replace(/^\[[^\]]+\]\s*[\w-]+\s*\|\s*/, '')}`;
    else if (entries.length > 1) {
      const byType = entries.reduce((m, e) => m.set(typeOf(e), (m.get(typeOf(e)) ?? 0) + 1), new Map());
      subject = `${domain} : ${entries.length} entrees du journal (${[...byType].map(([t, n]) => `${t} ${n}`).join(', ')})`;
    } else subject = `${domain} : mise a jour du coffre`;
  }
  if (subject.length > 100) subject = `${subject.slice(0, 99)}…`;
  const body =
    entries.length > 1
      ? entries.slice(0, 30).map((e) => `- ${e}`).join('\n') + (entries.length > 30 ? `\n- … et ${entries.length - 30} de plus` : '')
      : '';

  if (dry) {
    console.log(`simulation : ${files.length} fichier(s) (${summary})\nsujet : ${subject}`);
    return 0;
  }
  const paths = files.map(({ file }) => file);
  const add = git(['add', '-A', '--', ...paths]);
  if (add.status !== 0) return console.log(`commit : git add a echoue : ${add.stderr.trim()}`), 1;
  const commit = git(['commit', '-q', '-m', subject, ...(body ? ['-m', body] : []), '--', ...paths]);
  if (commit.status !== 0) {
    console.log(`commit : git commit a echoue (les fichiers restent indexes) : ${(commit.stderr || commit.stdout).trim()}`);
    return 1;
  }
  const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  console.log(`commite ${head} : ${files.length} fichier(s) (${summary})\nsujet : ${subject}\npush non fait : a lancer quand tu le decides`);
  return 0;
};

const [cmd, ...args] = process.argv.slice(2);
const table = { commit: cmdCommit, check: cmdCheck, verdict: cmdVerdict, promote: cmdPromote, quarantine: cmdQuarantine, undecided: cmdUndecided, audit: cmdAudit, flag: cmdFlag, decide: cmdDecide, seed: cmdSeed, stage: cmdStage, 'rotate-log': cmdRotateLog, 'propose-org': cmdProposeOrg, 'tag-org': cmdTagOrg, 'propose-raw': cmdProposeRaw, 'tag-raw': cmdTagRaw };
if (!table[cmd]) {
  console.log('usage : vault.mjs commit|check|verdict|promote|stage|rotate-log|propose-org|tag-org|quarantine|undecided ... (voir l\'en-tete du fichier)');
  process.exit(1);
}
try {
  process.exit((await table[cmd](args)) ?? 0);
} catch (error) {
  console.log(`vault.mjs : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
