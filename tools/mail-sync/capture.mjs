/**
 * Le depot d'un compte mail dans inbox/ : fils du libelle, depuis une date, dedupliques, rendus en bronze.
 *
 * Ne classe rien (aucun domaine ici : l'indice `hint` est ecrit dans le fichier, le tri decide), n'ecrit jamais hors
 * de inbox/, ne reecrit jamais un fichier (creation exclusive : un nom deja pris est signale, pas ecrase).
 * Pieces jointes : un PDF devient une source a part (fiche .pdf.md + le PDF) ; au-dela de la taille maximale, ou tout
 * autre type, il est ignore et liste dans le rapport (et nomme dans le fil, a sa place).
 *
 * Le fournisseur est injecte (interface de providers/gmail.mjs) : ce module ne sait pas ce qu'est Gmail.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { buildPdfStub, buildThread, pdfFileName } from './bronze.mjs';
import { classifyThread, knownAttachment, loadRegistry, scanMail } from './dedup.mjs';

export const DEFAULT_LABEL = 'kb';
export const DEFAULT_MAX_PDF_MB = 20;

const isPdf = (a) => a.mimeType === 'application/pdf' || (/\.pdf$/i.test(a.filename) && /octet-stream|pdf/i.test(a.mimeType));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Creation exclusive : true si ecrit, false si le nom existait deja. */
const create = (file, data) => {
  try {
    writeFileSync(file, data, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
};

/**
 * Capte un compte. Rend { deposited: [fichiers], pdfs: [fichiers], ignored: [{ thread, filename, reason }], counts }.
 * @param {object} p
 * @param {string} p.vault
 * @param {{id: string, label?: string, hint?: object}} p.account
 * @param {{listThreads: Function, getThread: Function, getAttachment: Function}} p.provider
 * @param {string} p.since            AAAA-MM-JJ
 * @param {boolean} [p.dryRun]
 * @param {number} [p.maxPdfBytes]
 * @param {(line: string) => void} [p.log]
 */
export const captureAccount = async ({ vault, account, provider, since, dryRun = false, maxPdfBytes = DEFAULT_MAX_PDF_MB * 1024 * 1024, log = console.log }) => {
  const label = account.label ?? DEFAULT_LABEL;
  const inbox = path.join(vault, 'inbox');
  const known = scanMail(vault);
  const registry = loadRegistry(vault);
  const out = { deposited: [], pdfs: [], ignored: [], counts: { nouveau: 0, suite: 0, connu: 0, ecarte: 0, contenu: 0 } };
  const threads = await provider.listThreads(label, since);
  log(`compte ${account.id} : ${threads.length} fil(s) du libelle "${label}" depuis ${since}`);
  if (!dryRun) mkdirSync(inbox, { recursive: true });

  for (const { id } of threads) {
    const thread = await provider.getThread(id);
    if (!thread.messages.length) continue;
    const c = classifyThread(thread, known, registry);
    if (c.kind === 'connu' || c.kind === 'ecarte') {
      out.counts[c.kind]++;
      log(`  [${c.kind === 'connu' ? 'connu:id' : 'ecarte:registre'}] fil ${thread.id}`);
      continue;
    }
    // Pieces jointes des messages nouveaux : decision par piece, avant d'ecrire le fil (le fil les nomme).
    const notes = new Map();
    const pending = [];
    for (const m of c.fresh) {
      for (const a of m.attachments) {
        const list = notes.get(m.id) ?? [];
        notes.set(m.id, list);
        if (!isPdf(a)) {
          list.push({ filename: a.filename, note: 'ignoree (pas un PDF)' });
          out.ignored.push({ thread: thread.id, filename: a.filename, reason: `type ${a.mimeType}` });
          continue;
        }
        if (a.size > maxPdfBytes) {
          list.push({ filename: a.filename, note: `ignoree (PDF de ${Math.round(a.size / 1024 / 1024)} Mo, maximum ${Math.round(maxPdfBytes / 1024 / 1024)} Mo)` });
          out.ignored.push({ thread: thread.id, filename: a.filename, reason: `PDF trop gros (${a.size} octets)` });
          continue;
        }
        const data = a.data?.length ? a.data : await provider.getAttachment(m.id, a.attachmentId);
        if (data.length > maxPdfBytes) {
          list.push({ filename: a.filename, note: 'ignoree (PDF au-dela de la taille maximale)' });
          out.ignored.push({ thread: thread.id, filename: a.filename, reason: `PDF trop gros (${data.length} octets)` });
          continue;
        }
        const sha = sha256(data);
        if (knownAttachment(sha, known, registry) || pending.some((p) => p.sha === sha)) {
          list.push({ filename: a.filename, note: 'deja captee (meme contenu)' });
          continue;
        }
        const pdfFile = pdfFileName({ filename: a.filename, sha, internalDate: m.internalDate });
        list.push({ filename: a.filename, note: `source separee \`${pdfFile}.md\`` });
        pending.push({ message: m, attachment: a, data, sha, pdfFile });
      }
    }
    const built = buildThread({ account: account.id, hint: account.hint, thread, messages: c.fresh, previous: c.previous, attachmentNotes: notes });
    if (known.bodies.has(built.bodySha)) {
      out.counts.contenu++;
      log(`  [connu:contenu] fil ${thread.id}`);
      continue;
    }
    const tagLabel = c.kind === 'suite' ? `[suite]  ${built.fileName}  (${c.fresh.length} message(s) nouveau(x), suite de ${c.previous.file ?? 'un fichier ecarte'})` : `[nouveau] ${built.fileName}  (${c.fresh.length} message(s))`;
    if (dryRun) {
      log(`  ${tagLabel}${pending.length ? `, ${pending.length} PDF` : ''}  (dry-run)`);
      out.counts[c.kind]++;
      continue;
    }
    if (!create(path.join(inbox, built.fileName), built.markdown)) {
      log(`  [nom pris] ${built.fileName} existe deja dans inbox/ : rien n'est ecrase, fil ${thread.id} laisse pour le prochain lancement`);
      continue;
    }
    out.counts[c.kind]++;
    out.deposited.push(built.fileName);
    known.bodies.add(built.bodySha);
    log(`  ${tagLabel}`);
    for (const p of pending) {
      // Le PDF d'abord, la fiche ensuite : une fiche sans son PDF serait une source vide.
      if (!create(path.join(inbox, p.pdfFile), p.data)) continue;
      create(path.join(inbox, `${p.pdfFile}.md`), buildPdfStub({ account: account.id, hint: account.hint, threadId: thread.id, message: p.message, attachment: p.attachment, sha: p.sha, pdfFile: p.pdfFile, threadFile: built.fileName }));
      known.attachments.add(p.sha);
      out.pdfs.push(p.pdfFile);
      log(`    [pdf] ${p.pdfFile}`);
    }
  }
  for (const i of out.ignored) log(`  [ignoree] ${i.filename} (fil ${i.thread}) : ${i.reason}`);
  return out;
};
