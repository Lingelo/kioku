#!/usr/bin/env node
/**
 * Recupere les notes Plaud via le MCP officiel (@plaud-ai/mcp) et les depose dans inbox/.
 *
 *   node tools/plaud-sync/fetch-notes.mjs --list                  liste les enregistrements recents
 *   node tools/plaud-sync/fetch-notes.mjs --since 2026-09-14      depose tout depuis cette date
 *   node tools/plaud-sync/fetch-notes.mjs --dry-run --since ...   affiche sans ecrire
 *   node tools/plaud-sync/fetch-notes.mjs --seed [--dry-run]      amorcage UNIQUE du registre seen.json (voir plus bas)
 *   options : --page-size N (25)   --skip <file_id> (repetable, consigne l'id dans seen.json comme « ecarte »)
 *
 * Ce script ne classe rien et n'ecrit jamais dans le wiki : il depose dans inbox/ (sans domaine).
 * Le tri pro/perso est fait ensuite par /triage, qui a le droit de s'abstenir. Plaud capte tout ce qui
 * passe par le micro (perso, RH d'autres organisations) : rien n'est range « par defaut ».
 *
 * Aucun token n'est lu ici : l'authentification est deleguee au MCP (OAuth, cache dans ~/.plaud/).
 * Port Node de l'ancien fetch_notes.py (Python n'est pas requis).
 *
 * Deduplication (dedup.mjs), sur les DEUX domaines et avant le tri : une note n'est jamais redeposee si son id Plaud
 * est deja dans seen.json ou dans un `plaud_id:` de inbox/, inbox/a-trancher/, raw/pro/ ou raw/perso/, si son nom de
 * fichier existe deja, ou si l'empreinte de son contenu egale celle d'un fichier present. Rapport : [connu:id],
 * [connu:nom], [connu:contenu], [ecarte:registre]. Chaque nouveau depot porte `plaud_id:` en frontmatter.
 *
 * Amorcage (--seed) : les bruts anterieurs n'ont pas de `plaud_id:` et sont immuables. Pour chaque enregistrement Plaud,
 * cherche un brut existant par empreinte puis par nom, et consigne {id, domaine} dans seen.json. Aucun brut n'est
 * reecrit ; ce qui n'est pas apparie est liste, non consigne. A lancer une fois, puis versionner seen.json.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vaultRoot } from '../vault-config.mjs';
import { addToRegistry, classify, legacyDomain, loadRegistry, scanKnown, withPlaudId } from './dedup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = vaultRoot(undefined);
const EXCLUSIONS = path.join(VAULT, 'tools', 'plaud-sync', 'exclusions.txt'); // etat du coffre, comme seen.json
// Le MCP encapsule les donnees utilisateur dans un bloc anti-injection dont le nom porte un nonce.
const UNTRUSTED = /^<(untrusted-user-data-[0-9a-f]+)\b[^>]*>([\s\S]*?)<\/\1>/m;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const skips = argv.flatMap((a, i) => (a === '--skip' ? [argv[i + 1]] : []));

const mcpCalls = (requests, timeoutMs = 300_000) => {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plaud-sync', version: '1.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...requests.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name, arguments: args } })),
  ];
  const win = process.platform === 'win32';
  const proc = spawnSync(win ? 'npx.cmd' : 'npx', ['-y', '@plaud-ai/mcp@latest'], {
    input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: win, // .cmd sous Windows
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) throw new Error(`MCP : ${proc.error.message}`);
  const byId = new Map();
  for (const raw of (proc.stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const msg = JSON.parse(line);
      if (Number.isInteger(msg.id)) byId.set(msg.id, msg);
    } catch {
      // ligne qui n'est pas du JSON-RPC
    }
  }
  return requests.map(([name], i) => {
    const msg = byId.get(i + 2);
    if (!msg) throw new Error(`pas de reponse pour ${name} — premiere connexion ? lance une fois : npx -y @plaud-ai/mcp@latest (OAuth). stderr: ${(proc.stderr ?? '').slice(-300)}`);
    if (msg.error) throw new Error(`${name} : ${JSON.stringify(msg.error)}`);
    return msg.result;
  });
};

const payload = (result) => {
  let text = (result.content ?? []).map((c) => c.text ?? '').join('');
  const m = text.match(UNTRUSTED);
  if (m) text = m[2];
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error(`reponse MCP non JSON : ${text.trim().slice(0, 200)}`);
  }
};

const slugify = (title) =>
  title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80).replace(/-+$/, '') || 'untitled-meeting';

const cleanTitle = (name) => {
  const stripped = name.replace(/^\d{2}-\d{2}\s*/, '').trim().replace(/^R[ée]union\s*:?\s*/i, '').trim();
  return stripped || name.trim();
};

const formatDate = (iso) => {
  const d = new Date(iso);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${weekday}, ${String(d.getDate()).padStart(2, '0')} ${month} ${String(d.getFullYear()).slice(-2)}`;
};

const pickSummary = (notes) => {
  const candidates = notes.filter((n) => (n.data_content ?? '').trim());
  if (!candidates.length) return null;
  const auto = candidates.find((n) => n.data_type === 'auto_sum_note');
  return (auto ?? candidates.reduce((a, b) => (b.data_content.length > a.data_content.length ? b : a))).data_content;
};

const loadExclusions = () =>
  new Set(
    existsSync(EXCLUSIONS)
      ? readFileSync(EXCLUSIONS, 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean)
      : [],
  );

const buildMarkdown = (name, started, body) => `# ${name}\n\n${formatDate(started)}\n\n${body.trim()}\n`;

const fileNameOf = (f) => {
  const name = cleanTitle(f.name ?? '');
  const started = f.start_at ?? '';
  return { name, started, fileName: `${started.slice(0, 10)}-${slugify(name)}.md` };
};

const MAX_PAGES = 40; // garde-fou : 40 pages × page_size enregistrements

// Le MCP pagine a partir de 1, exige page_size >= 10 et renvoie une page vide au-dela de la fin.
// Avec date_from il ignore page_size et renvoie toute la fenetre a chaque page : on s'arrete donc des
// qu'une page n'apporte aucun id nouveau (sinon la meme fenetre serait relue MAX_PAGES fois).
const listAll = (since) => {
  const pageSize = Math.max(10, Number(opt('--page-size') ?? 25));
  const byId = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = payload(mcpCalls([['list_files', { page, page_size: pageSize, ...(since ? { date_from: since } : {}) }]])[0]).data ?? [];
    const before = byId.size;
    for (const f of batch) byId.set(f.id, f);
    if (byId.size === before || batch.length < pageSize) return [...byId.values()];
  }
  const all = [...byId.values()];
  console.error(`Attention : ${MAX_PAGES} pages lues, la liste est peut-etre tronquee. Reduis --since.`);
  return all;
};

// Amorcage unique : consigne dans seen.json {id, domaine} pour chaque enregistrement dont un brut existe deja dans
// raw/pro ou raw/perso (empreinte du contenu, sinon nom de fichier). Ne reecrit aucun brut. Le non-apparie est liste, pas consigne.
const seed = (files, excluded) => {
  const known = scanKnown(VAULT);
  const registry = loadRegistry(VAULT);
  const todo = files.filter((f) => !excluded.has(f.id) && !known.ids.has(f.id) && !registry.some((e) => e.id === f.id));
  if (!todo.length) return console.log('Rien a amorcer : tous les enregistrements sont deja couverts.'), 0;

  const notes = mcpCalls(todo.map((f) => ['get_note', { file_id: f.id }]));
  let matched = 0;
  const unmatched = [];
  todo.forEach((f, i) => {
    const { name, started, fileName } = fileNameOf(f);
    let markdown;
    try {
      const body = pickSummary(payload(notes[i]));
      markdown = body ? buildMarkdown(name, started, body) : undefined;
    } catch {
      markdown = undefined; // illisible : on retombe sur le nom
    }
    const domain = legacyDomain({ fileName, markdown }, known);
    if (!domain) return unmatched.push(`${started.slice(0, 16)}  ${f.id}  ${(f.name ?? '').slice(0, 60)}`);
    console.log(`[amorce:${domain}]  ${fileName}`);
    if (!flag('--dry-run')) addToRegistry(VAULT, f.id, domain);
    matched++;
  });
  console.log(`\n${matched} enregistrement(s) apparie(s)${flag('--dry-run') ? ' (dry-run : seen.json inchange)' : ' et consigne(s) dans tools/plaud-sync/seen.json'}.`);
  if (unmatched.length) {
    console.log(`${unmatched.length} sans brut correspondant (non consignes : ecarte a la main, jamais importe, ou brut retitre) :`);
    for (const u of unmatched) console.log(`  ${u}`);
    console.log('Pour en ecarter un pour de bon : relancer avec --skip <id>.');
  }
  return 0;
};

const main = () => {
  const inbox = path.join(VAULT, 'inbox');
  const excluded = new Set([...loadExclusions(), ...skips]);
  const since = opt('--since');
  let files = listAll(since);
  if (since) files = files.filter((f) => (f.start_at ?? '') >= since);
  files.sort((a, b) => (a.start_at ?? '').localeCompare(b.start_at ?? ''));

  if (flag('--list')) {
    for (const f of files) console.log(`${(f.start_at ?? '').slice(0, 16)}  ${(f.name ?? '').slice(0, 70)}${excluded.has(f.id) ? '  [EXCLU]' : ''}`);
    console.log(`\n${files.length} enregistrement(s).`);
    return 0;
  }

  if (flag('--seed')) return seed(files, excluded);

  // --skip est consigne : l'id revient « ecarte » a chaque lancement, meme si la fenetre de dates le contient encore.
  if (!flag('--dry-run')) for (const id of skips) addToRegistry(VAULT, id, 'ecarte');

  const known = scanKnown(VAULT);
  const registry = loadRegistry(VAULT);
  const todo = [];
  for (const f of files) {
    if (excluded.has(f.id)) {
      console.log(`[exclu]   ${(f.name ?? '').slice(0, 60)}`);
      continue;
    }
    const { name, started, fileName } = fileNameOf(f);
    const verdict = classify({ id: f.id, fileName }, { known, registry }); // avant get_note : id et nom seulement
    if (verdict) {
      console.log(`[${verdict}]   ${verdict === 'ecarte:registre' ? (f.name ?? '').slice(0, 60) : fileName}`);
      continue;
    }
    todo.push({ f, name, started, fileName });
  }
  if (!todo.length) return console.log('\nRien a deposer.'), 0;

  const notes = mcpCalls(todo.map(({ f }) => ['get_note', { file_id: f.id }]));
  mkdirSync(inbox, { recursive: true });
  let written = 0;
  todo.forEach(({ f, name, started, fileName }, i) => {
    let body;
    try {
      body = pickSummary(payload(notes[i]));
    } catch (e) {
      return console.error(`[illisible] ${fileName} : ${e.message}`);
    }
    if (!body) return console.log(`[sans resume] ${fileName} — ignore`);
    const markdown = buildMarkdown(name, started, body);
    const verdict = classify({ id: f.id, fileName, markdown }, { known, registry }); // le contenu, filet quand ni id ni nom ne concordent
    if (verdict) return console.log(`[${verdict}]   ${fileName}`);
    const deposit = withPlaudId(markdown, f.id);
    if (flag('--dry-run')) return console.log(`[dry-run] ${fileName} (${deposit.length} car.)`);
    writeFileSync(path.join(inbox, fileName), deposit, { encoding: 'utf8', flag: 'wx' }); // wx : jamais d'ecrasement
    console.log(`[depose]  inbox/${fileName} (${deposit.length} car.)`);
    written++;
  });
  console.log(`\n${written} note(s) deposee(s) dans ${inbox}. Etape suivante : /triage (session VAULT_MODE=triage).`);
  return 0;
};

try {
  process.exit(main());
} catch (error) {
  console.error(`Erreur : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
