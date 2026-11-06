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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { buildPdfStub, buildThread, pdfFileName } from './bronze.mjs';
import { classifyThread, knownAttachment, loadRegistry, scanMail } from './dedup.mjs';

export const DEFAULT_LABEL = 'kb';
export const DEFAULT_MAX_PDF_MB = 20;
// Plafond de fils deposes (nouveaux ou suites) par compte et par lancement (revue m6) : un libelle trop large ne
// deverse pas des centaines de sources d'un coup. Les plus anciens d'abord : les lancements suivants avancent.
export const DEFAULT_MAX_THREADS = 100;

const isPdf = (a) => a.mimeType === 'application/pdf' || (/\.pdf$/i.test(a.filename) && /octet-stream|pdf/i.test(a.mimeType));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Creation exclusive : true si ecrit, false si le nom existait deja. `write` : injecte par les tests (panne disque). */
const creator = (write) => (file, data) => {
  try {
    write(file, data, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
};
const sameBytes = (file, data) => {
  try {
    return readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data));
  } catch {
    return false;
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
export const captureAccount = async ({ vault, account, provider, since, dryRun = false, maxPdfBytes = DEFAULT_MAX_PDF_MB * 1024 * 1024, log = console.log, writeFile = writeFileSync, maxThreads = DEFAULT_MAX_THREADS }) => {
  const create = creator(writeFile);
  const label = account.label ?? DEFAULT_LABEL;
  const inbox = path.join(vault, 'inbox');
  const known = scanMail(vault);
  const registry = loadRegistry(vault);
  const out = { deposited: [], pdfs: [], ignored: [], warnings: [], capped: 0, counts: { nouveau: 0, suite: 0, connu: 0, ecarte: 0, contenu: 0 } };
  const threads = await provider.listThreads(label, since);
  log(`compte ${account.id} : ${threads.length} fil(s) du libelle "${label}" depuis ${since}`);
  if (!dryRun) mkdirSync(inbox, { recursive: true });

  // Gmail rend les fils du plus recent au plus ancien : on part des plus anciens, pour qu'un plafond atteint laisse les
  // plus recents au lancement suivant (et que l'ordre des suites soit celui du temps).
  const ordered = [...threads].reverse();
  for (let n = 0; n < ordered.length; n++) {
    if (out.counts.nouveau + out.counts.suite >= maxThreads) {
      out.capped = ordered.length - n;
      log(`  [plafond] ${maxThreads} fil(s) depose(s) : ${out.capped} fil(s) non examine(s), pour le prochain lancement (ou --max-threads N)`);
      break;
    }
    const { id } = ordered[n];
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
    if (existsSync(path.join(inbox, built.fileName))) {
      log(`  [nom pris] ${built.fileName} existe deja dans inbox/ : rien n'est ecrase, fil ${thread.id} laisse pour le prochain lancement`);
      continue;
    }
    // Ordre (revue I4) : les PDF et leurs fiches AVANT le fil. C'est le fil qui marque ses messages « couverts » : ecrit
    // en premier, un PDF perdu ensuite (disque plein, arret) ne serait plus jamais reexamine. Une panne en cours de
    // route retire ce que ce fil a deja ecrit et remonte l'erreur : au lancement suivant, le fil est encore nouveau.
    const written = [];
    try {
      for (const p of pending) {
        const pdfPath = path.join(inbox, p.pdfFile);
        const stubPath = path.join(inbox, `${p.pdfFile}.md`);
        if (create(pdfPath, p.data)) written.push(pdfPath);
        else if (!sameBytes(pdfPath, p.data)) throw new Error(`${p.pdfFile} existe deja dans inbox/ avec un autre contenu`);
        // Le PDF d'abord, la fiche ensuite : une fiche sans son PDF serait une source vide.
        if (create(stubPath, buildPdfStub({ account: account.id, hint: account.hint, threadId: thread.id, message: p.message, attachment: p.attachment, sha: p.sha, pdfFile: p.pdfFile, threadFile: built.fileName }))) written.push(stubPath);
      }
      if (!create(path.join(inbox, built.fileName), built.markdown)) throw new Error(`${built.fileName} cree entre-temps par un autre processus`);
    } catch (error) {
      for (const f of written.reverse()) rmSync(f, { force: true });
      throw new Error(`fil ${thread.id} non depose (${error.message}) : rien n'en reste dans inbox/, il sera repris au prochain lancement`);
    }
    out.counts[c.kind]++;
    out.deposited.push(built.fileName);
    if (built.warnings.length) {
      out.warnings.push({ file: built.fileName, warnings: built.warnings });
      log(`  [avertissement] ${built.fileName} : ${built.warnings.join(', ')} (texte qui ressemble a du quoted-printable non decode, laisse tel quel : a verifier)`);
    }
    known.bodies.add(built.bodySha);
    log(`  ${tagLabel}`);
    for (const p of pending) {
      known.attachments.add(p.sha);
      out.pdfs.push(p.pdfFile);
      log(`    [pdf] ${p.pdfFile}`);
    }
  }
  for (const i of out.ignored) log(`  [ignoree] ${i.filename} (fil ${i.thread}) : ${i.reason}`);
  return out;
};
