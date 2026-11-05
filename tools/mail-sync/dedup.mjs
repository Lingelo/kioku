/**
 * Deduplication des fils de mail, sur tous les domaines a la fois et avant le tri.
 *
 * Ce qui fait foi : les fichiers deja deposes (inbox/, inbox/a-trancher/, raw/<D>/ de chaque domaine declare) et le
 * registre `tools/mail-sync/seen.json` (versionne, sans contenu). Pour un fil :
 *   - `thread:<id>` au registre (`--skip`)                         -> ecarte, jamais redepose ;
 *   - tous ses messages deja couverts (`message_ids:` d'un fichier, ou d'un fichier ecarte par `--drop`) -> connu ;
 *   - une partie couverte, des messages nouveaux                    -> SUITE : seuls les nouveaux, lies au dernier
 *     fichier du fil. Le bronze n'est jamais reecrit ;
 *   - rien de couvert                                               -> nouveau ;
 * puis, pour un depot, l'empreinte du contenu (`body_sha256`) : un meme contenu deja present (meme mail capte sur deux
 * comptes) n'est pas redepose. Un PDF : par l'empreinte de ses octets (`attachment_sha256`, et `att:<sha>` au registre).
 *
 * Ce module lit des identifiants et des empreintes de frontmatter, jamais un contenu.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { addToRegistryAt, frontmatterValue, loadRegistryAt, mdFiles, places } from '../connectors/dedup.mjs';

export const STATE = 'tools/mail-sync';
export const registryPath = (vault) => path.join(vault, ...STATE.split('/'), 'seen.json');
export const loadRegistry = (vault) => loadRegistryAt(registryPath(vault));
export const addToRegistry = (vault, entry) => {
  mkdirSync(path.dirname(registryPath(vault)), { recursive: true });
  return addToRegistryAt(registryPath(vault), { date: new Date().toISOString().slice(0, 10), ...entry });
};

const posix = (p) => p.split(path.sep).join('/');
const head = (text) => text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
const jsonField = (text, key) => {
  const m = head(text).match(new RegExp(`^${key}:\\s*(\\[.*\\])\\s*$`, 'm'));
  try {
    return m ? JSON.parse(m[1]) : [];
  } catch {
    return [];
  }
};

/** Photo de ce que le coffre contient deja, cote mail. */
export const scanMail = (vault) => {
  const threads = new Map(); // id du fil -> [{ file, last, messages, date }]
  const bodies = new Set();
  const attachments = new Set();
  for (const [rel, recursive] of places(vault)) {
    for (const abs of mdFiles(path.join(vault, rel), recursive)) {
      const text = readFileSync(abs, 'utf8');
      const tid = frontmatterValue(text, 'gmail_thread_id');
      if (!tid) continue;
      const att = frontmatterValue(text, 'attachment_sha256');
      if (att) {
        attachments.add(att);
        continue;
      }
      const last = frontmatterValue(text, 'last_message_id');
      const body = frontmatterValue(text, 'body_sha256');
      if (body) bodies.add(body);
      const ids = jsonField(text, 'message_ids').map(String);
      const entry = { file: path.basename(abs), path: posix(path.relative(vault, abs)), last, messages: ids.length ? ids : last ? [last] : [], date: frontmatterValue(text, 'date') ?? '' };
      threads.set(tid, [...(threads.get(tid) ?? []), entry]);
    }
  }
  return { threads, bodies, attachments };
};

/** Identifiant de registre d'un fichier ecarte (--drop) : fil + messages couverts, ou empreinte du PDF. */
export const dropIdOf = (text) => {
  const tid = frontmatterValue(text, 'gmail_thread_id');
  if (!tid) return null;
  const att = frontmatterValue(text, 'attachment_sha256');
  if (att) return `att:${att}`;
  const ids = jsonField(text, 'message_ids').map(String);
  const last = frontmatterValue(text, 'last_message_id');
  const covered = ids.length ? ids : last ? [last] : [];
  return covered.length ? `msgs:${tid}:${covered.join(',')}` : null;
};

/** Le registre en entrees exploitables : fils ecartes, messages couverts par un fichier ecarte, PDF ecartes. */
const registryView = (registry) => {
  const skipped = new Set();
  const covered = new Map();
  const attachments = new Set();
  for (const e of registry) {
    const id = String(e?.id ?? '');
    if (id.startsWith('thread:')) skipped.add(id.slice(7));
    else if (id.startsWith('att:')) attachments.add(id.slice(4));
    else if (id.startsWith('msgs:')) {
      const [, tid, list = ''] = id.match(/^msgs:([^:]+):(.*)$/) ?? [];
      if (tid) covered.set(tid, new Set([...(covered.get(tid) ?? []), ...list.split(',').filter(Boolean)]));
    }
  }
  return { skipped, covered, attachments };
};

/**
 * Classe un fil. Rend { kind: 'ecarte'|'connu'|'nouveau'|'suite', fresh, previous }.
 * `previous` (suite) : le dernier fichier connu du fil { file, lastMessageId }, ou { file: null } si seul un fichier
 * ecarte le couvrait.
 */
export const classifyThread = (thread, known, registry) => {
  const reg = registryView(registry);
  if (reg.skipped.has(thread.id)) return { kind: 'ecarte', fresh: [], previous: null };
  const files = known.threads.get(thread.id) ?? [];
  const covered = new Set([...files.flatMap((f) => f.messages), ...(reg.covered.get(thread.id) ?? [])]);
  const fresh = thread.messages.filter((m) => !covered.has(String(m.id)));
  if (!fresh.length) return { kind: 'connu', fresh: [], previous: null };
  if (!covered.size) return { kind: 'nouveau', fresh, previous: null };
  // Le fichier precedent : celui qui couvre le message le plus recent deja couvert (ordre du fil).
  const order = new Map(thread.messages.map((m, i) => [String(m.id), i]));
  const rank = (f) => Math.max(-1, ...f.messages.map((id) => order.get(id) ?? -1));
  const prev = [...files].sort((a, b) => rank(b) - rank(a) || b.date.localeCompare(a.date))[0];
  return { kind: 'suite', fresh, previous: prev ? { file: prev.file, lastMessageId: prev.last } : { file: null, lastMessageId: [...covered].pop() } };
};

/** Un PDF deja vu (fichier present ou ecarte) ? */
export const knownAttachment = (sha, known, registry) => known.attachments.has(sha) || registryView(registry).attachments.has(sha);
