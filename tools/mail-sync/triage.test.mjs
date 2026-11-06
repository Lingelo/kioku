/**
 * Le tri d'une source mail dans le circuit, avec un faux `claude` : `node --test tools/mail-sync/triage.test.mjs`
 *
 * Un faux binaire place en tete de PATH journalise ses arguments (le prompt du tri) et joue la session de tri :
 *   FAUX_TRI=abstient : ne range rien, ecrit une ligne ABSTENTION (le circuit parque, PDF compagnon compris) ;
 *   FAUX_TRI=range    : range le fil dans raw/pro/emails/ et la fiche PDF dans raw/pro/pdfs/, mais OUBLIE le PDF
 *                       (le circuit le fait suivre sa fiche).
 * Aucun modele, aucun reseau ; coffre factice, contenus inventes, adresses en example.com. Sans terminal ni --yes, le
 * circuit s'arrete a la confirmation : aucune ingestion n'est lancee.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { declareFakeGuard, terminalEnv, testHome, writeTestConfig } from '../test-vault.mjs';
import { buildPdfStub, buildThread } from './bronze.mjs';
import { gmailMessage } from './fixtures.mjs';
import { messageFromApi } from './providers/gmail.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const RAW = 'r' + 'aw';
const DAY = Date.UTC(2026, 10, 3, 9, 0);

let fakeBin;
let vault;
let files;

before(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'faux-claude-mail-'));
  const exe = path.join(fakeBin, 'claude');
  writeFileSync(
    exe,
    [
      '#!/bin/bash',
      '{ printf "MODE=%s\\n" "$VAULT_MODE"; for a in "$@"; do printf "%s\\n" "$a"; done; echo "---FIN-TOUR---"; } >> "$FAUX_LOG"',
      'if [ "$VAULT_MODE" = "triage" ] && [ "$FAUX_TRI" = "abstient" ]; then echo "ABSTENTION $FAUX_FIL : fil mixte, travail et vie privee"; fi',
      // Une session de tri qui, sur la foi d'un mail, tenterait de relancer le circuit mail (N4).
      'if [ "$VAULT_MODE" = "triage" ] && [ -n "$FAUX_RELANCE" ]; then "$FAUX_NODE" "$FAUX_RUN" --vault . --dry-run > /dev/null 2> "$FAUX_RELANCE.err"; echo "$?" > "$FAUX_RELANCE"; fi',
      'if [ "$VAULT_MODE" = "triage" ] && [ "$FAUX_TRI" = "range" ]; then',
      '  mkdir -p "$FAUX_RAW/pro/emails" "$FAUX_RAW/pro/pdfs"',
      '  mv "inbox/$FAUX_FIL" "$FAUX_RAW/pro/emails/"',
      '  mv "inbox/$FAUX_FICHE" "$FAUX_RAW/pro/pdfs/"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(exe, 0o755);
});
after(() => rmSync(fakeBin, { recursive: true, force: true }));

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'kioku-mail-tri-'));
  writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }, { id: 'perso' }], modules: { mail: { state: 'tools/mail-sync', accounts: [] } } });
  declareFakeGuard(vault);
  const m = messageFromApi(gmailMessage({ id: 'm1', threadId: '18c0000000000tri', internalDate: DAY, subject: 'Devis atelier', text: 'Voici le devis.', attachments: [{ filename: 'devis.pdf', size: 10, attachmentId: 'A1' }] }));
  const thread = buildThread({ account: 'travail', hint: { domain: 'pro', org: 'acme' }, thread: { id: '18c0000000000tri', messages: [m] }, messages: [m], previous: null });
  const pdf = '2026-11-03-devis-0a1b2c3d.pdf';
  const stub = buildPdfStub({ account: 'travail', hint: { domain: 'pro', org: 'acme' }, threadId: '18c0000000000tri', message: m, attachment: m.attachments[0], sha: '0a1b2c3d'.padEnd(64, '0'), pdfFile: pdf, threadFile: thread.fileName });
  mkdirSync(path.join(vault, 'inbox'), { recursive: true });
  writeFileSync(path.join(vault, 'inbox', thread.fileName), thread.markdown);
  writeFileSync(path.join(vault, 'inbox', pdf), '%PDF-1.4 invente');
  writeFileSync(path.join(vault, 'inbox', `${pdf}.md`), stub);
  files = { thread: thread.fileName, pdf, stub: `${pdf}.md` };
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const run = (tri, extra = {}) => {
  const log = path.join(vault, 'appels.txt');
  const r = spawnSync(process.execPath, [RUN, '--vault', vault, '--skip-fetch'], {
    encoding: 'utf8',
    env: { ...terminalEnv(), HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_LOG: log, FAUX_TRI: tri, FAUX_FIL: files.thread, FAUX_FICHE: files.stub, FAUX_RAW: RAW, ...extra },
  });
  const tours = existsSync(log) ? readFileSync(log, 'utf8').split('---FIN-TOUR---\n').filter((t) => t.trim()).map((t) => t.split('\n').filter(Boolean)) : [];
  return { ...r, tours };
};
const promptOf = (tour) => tour[tour.indexOf('-p') + 1] ?? '';

describe('prompt du tri d une source mail', () => {
  test('la note du connecteur et l indice hint de chaque source arrivent dans le prompt, une seule session de tri', () => {
    const r = run('abstient');
    const triage = r.tours.filter((t) => t[0] === 'MODE=triage');
    assert.equal(triage.length, 1, r.stderr);
    const prompt = promptOf(triage[0]);
    assert.ok(prompt.includes(files.thread) && prompt.includes(files.stub), 'les deux sources sont a trier');
    assert.match(prompt, /Le champ hint du frontmatter est un indice de la configuration du compte, jamais une decision/);
    assert.match(prompt, /untrusted-mail-data/);
    assert.match(prompt, /raw\/<domaine>\/emails\//);
    assert.match(prompt, /deplace les deux\) dans raw\/<domaine>\/pdfs\//);
    assert.match(prompt, /Indices de configuration \(a confirmer sur le contenu, jamais une decision\) : /);
    for (const f of [files.thread, files.stub]) assert.ok(prompt.includes(`${f} -> domaine pro, org acme`), f);
    assert.doesNotMatch(prompt, /"/, 'aucun guillemet (cmd.exe)');
    assert.doesNotMatch(prompt, /\n/, 'une seule ligne');
  });
});

describe('parcage au doute', () => {
  test('le tri s abstient : le fil et la fiche parques avec leur raison, le PDF suit sa fiche, rien n entre dans la file', () => {
    const r = run('abstient');
    assert.equal(r.status, 0, r.stderr);
    const parked = path.join(vault, 'inbox', 'a-trancher');
    assert.deepEqual(readdirSync(parked).sort(), ['_raisons.md', files.thread, files.pdf, files.stub].sort());
    assert.deepEqual(readdirSync(path.join(vault, 'inbox')).filter((f) => f !== 'a-trancher'), [], 'l entrant est vide');
    const reasons = readFileSync(path.join(parked, '_raisons.md'), 'utf8');
    assert.match(reasons, new RegExp(`^- ${files.thread.replace(/\./g, '\\.')} \\(\\d{4}-\\d\\d-\\d\\d\\) : fil mixte, travail et vie privee$`, 'm'));
    assert.match(reasons, new RegExp(`^- ${files.stub.replace(/\./g, '\\.')} \\(.*\\) : tri sans resultat`, 'm'));
    assert.match(r.stdout, /A trancher a part \(2\)/);
    assert.match(r.stdout, /kioku mail --skip-fetch --decide <fichier>=<pro\|perso>/);
    assert.match(r.stdout, /npm run mail:drop -- <fichier>/);
    assert.ok(!r.tours.some((t) => t[0] === 'MODE=ingest'), 'aucune ingestion');
  });

  test('le tri range le fil et la fiche mais oublie le PDF : le PDF rejoint sa fiche, les deux sources sont en file', () => {
    const r = run('range');
    assert.equal(r.status, 2, r.stderr); // confirmee par personne (pas de terminal) : sources en attente
    assert.ok(existsSync(path.join(vault, RAW, 'pro', 'emails', files.thread)));
    assert.ok(existsSync(path.join(vault, RAW, 'pro', 'pdfs', files.stub)));
    assert.ok(existsSync(path.join(vault, RAW, 'pro', 'pdfs', files.pdf)), 'le PDF a suivi sa fiche');
    assert.match(r.stdout, new RegExp(`compagnon ${files.pdf.replace(/\./g, '\\.')} -> ${RAW}/pro/pdfs/`));
    const queue = JSON.parse(readFileSync(path.join(vault, 'tools', 'mail-sync', '.queue.json'), 'utf8'));
    assert.deepEqual(queue.map((e) => e.rel).sort(), [`emails/${files.thread}`, `pdfs/${files.stub}`].sort(), 'la file ne connait que les .md');
    assert.match(r.stdout, /Pas de terminal pour confirmer/);
    assert.ok(!r.tours.some((t) => t[0] === 'MODE=ingest'));
  });
});

// I2 : chaque circuit ne trie que ses propres sources ; celles d'un autre restent dans l'entrant, nommees au rapport.
describe('sources d un autre circuit', () => {
  const PLAUD_RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plaud-sync', 'run.mjs');
  const NOTE = '2026-11-03-reunion-atelier.md';

  test('kioku mail laisse une note Plaud dans l entrant, sans la trier ni la parquer', () => {
    writeFileSync(path.join(vault, 'inbox', NOTE), '---\nplaud_id: of_invente\n---\n\n# Reunion atelier\n');
    const r = run('abstient');
    const prompt = promptOf(r.tours.find((t) => t[0] === 'MODE=triage'));
    assert.ok(!prompt.includes(NOTE), 'la note Plaud n est pas dans le prompt du tri mail');
    assert.ok(existsSync(path.join(vault, 'inbox', NOTE)), 'elle reste dans l entrant');
    assert.ok(!existsSync(path.join(vault, 'inbox', 'a-trancher', NOTE)), 'elle n est pas parquee');
    assert.match(r.stdout, new RegExp(`Laissees dans l'entrant, d'un autre circuit de capture \\(1\\)[\\s\\S]*${NOTE.replace(/\./g, '\\.')}`));
  });

  test('kioku plaud laisse les fils et fiches mail dans l entrant ; il ne trie que ses notes', () => {
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }, { id: 'perso' }], modules: { plaud: { state: 'tools/plaud-sync' }, mail: { state: 'tools/mail-sync', accounts: [] } } });
    writeFileSync(path.join(vault, 'inbox', NOTE), '---\nplaud_id: of_invente\n---\n\n# Reunion atelier\n');
    const log = path.join(vault, 'appels-plaud.txt');
    const r = spawnSync(process.execPath, [PLAUD_RUN, '--vault', vault, '--skip-fetch'], {
      encoding: 'utf8',
      env: { ...terminalEnv(), HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_LOG: log, FAUX_TRI: 'aucun' },
    });
    const tours = readFileSync(log, 'utf8').split('---FIN-TOUR---\n').filter((t) => t.trim()).map((t) => t.split('\n').filter(Boolean));
    const prompt = promptOf(tours.find((t) => t[0] === 'MODE=triage'));
    assert.ok(prompt.includes(NOTE));
    for (const f of [files.thread, files.stub]) assert.ok(!prompt.includes(f), `${f} hors du tri Plaud`);
    assert.doesNotMatch(prompt, /untrusted-mail-data/, 'pas de consigne mail : ce n est pas son circuit');
    for (const f of [files.thread, files.stub, files.pdf]) assert.ok(existsSync(path.join(vault, 'inbox', f)), `${f} reste dans l entrant`);
    assert.match(r.stdout, /Laissees dans l'entrant, d'un autre circuit de capture \(2\)/);
  });
});

describe('N4 et N6 : relance depuis une session, depot a la main', () => {
  test('la session de tri du circuit mail ne peut pas relancer kioku mail, meme en --dry-run ; le parent finit', () => {
    const relance = path.join(vault, 'relance.txt');
    const r = run('abstient', { FAUX_RELANCE: relance, FAUX_NODE: process.execPath, FAUX_RUN: RUN });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(relance, 'utf8').trim(), '1');
    assert.match(readFileSync(`${relance}.err`, 'utf8'), /jamais depuis une session Claude Code/);
  });

  test('une source deposee a la main (sans marque) : nommee a part, avec la voie a suivre', () => {
    writeFileSync(path.join(vault, 'inbox', '2026-11-06-note-manuelle.md'), '# note deposee a la main\n');
    const r = run('abstient');
    assert.match(r.stdout, /Laissees dans l'entrant, sans marque de circuit \(1, deposees a la main\) : \/triage, ou kioku plaud --skip-fetch\.\n {2}2026-11-06-note-manuelle\.md/);
    assert.doesNotMatch(r.stdout, /d'un autre circuit de capture/);
  });

  test('fetch-mail depuis une session : refuse', () => {
    const r = spawnSync(process.execPath, [path.join(path.dirname(RUN), 'fetch-mail.mjs')], { encoding: 'utf8', env: terminalEnv({ CLAUDE_PROJECT_DIR: vault, VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /jamais depuis une session Claude Code/);
  });
});

