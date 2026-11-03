/**
 * tools/dashboard/ask.test.mjs
 *
 * Lanceur des questions de l'onglet 問 Question (plan 2026-10-02-2218, U1).
 * `node --test tools/dashboard/ask.test.mjs` — avec un faux `claude`, jamais une vraie session.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createAsker, translateLine } from './ask.mjs';
import { CORE_BIN } from '../core-path.mjs';
import { declareFakeGuard, isolateHome, writeTestConfig } from '../test-vault.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

let vault;
let record;

const makeAsker = (domain = 'pro') => createAsker({ vaultRoot: vault, domain, command: process.execPath, commandArgs: [FAKE] });

/**
 * Lance un tour et collecte ses evenements jusqu'a l'evenement final.
 * `onFirstText(handle)` est appele au premier fragment de texte : le faux claude a demarre, lu sa question et ecrit.
 * C'est le signal d'action des tests d'annulation, a la place d'un delai fixe qui lache sous charge.
 */
const run = (asker, question, thread = null, { onStart, onFirstText } = {}) =>
  new Promise((resolve) => {
    const events = [];
    let handle;
    let fired = false;
    handle = asker.ask(question, thread, (evt) => {
      events.push(evt);
      if (evt.type === 'text' && onFirstText && !fired) {
        fired = true;
        // Le rappel peut arriver avant le retour de ask() : on differe d'un tour de boucle pour que handle existe.
        setImmediate(() => onFirstText(handle));
      }
      if (['done', 'error', 'cancelled'].includes(evt.type)) resolve({ events, final: evt });
    });
    if (handle === null) resolve({ events, final: null, refused: true });
    else if (onStart) onStart(handle);
  });

const calls = () =>
  readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// La garde declaree est le hook factice : les settings de la machine (plugin kioku active) n'entrent pas en jeu.
let restoreHome = () => {};
beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'ask-test-'));
  writeTestConfig(vault);
  declareFakeGuard(vault);
  restoreHome = isolateHome(vault);
  record = path.join(vault, 'record.jsonl');
  writeFileSync(record, '');
  process.env.FAKE_CLAUDE_RECORD = record;
  process.env.FAKE_CLAUDE_SCENARIO = 'ok';
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_RECORD;
  delete process.env.FAKE_CLAUDE_SCENARIO;
  restoreHome();
  rmSync(vault, { recursive: true, force: true });
});

describe('U1 : lanceur de session question', () => {
  test('happy path : lectures de l or dedoublonnees, fragments, puis done avec le Markdown complet', async () => {
    const { events, final } = await run(makeAsker(), 'Ou en est Atlas ?');
    assert.deepEqual(
      events.filter((e) => e.type === 'read').map((e) => e.path),
      ['index.md', 'projects/atlas.md']
    );
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'La v2 est livree.');
    assert.equal(final.type, 'done');
    assert.equal(final.markdown, 'La v2 est livree.');
    assert.equal(final.pagesRead, 2);
    assert.match(final.thread, /^[0-9a-f-]{36}$/);
    assert.ok(final.durationMs >= 0);
  });

  test('environnement, racine et outils : mode query, domaine du serveur, cwd et CLAUDE_PROJECT_DIR au coffre', async () => {
    await run(makeAsker('perso'), 'Question');
    const [c] = calls();
    assert.equal(c.mode, 'query');
    assert.equal(c.domain, 'perso');
    assert.equal(realpathSync(c.cwd), realpathSync(vault));
    assert.equal(c.projectDir, vault);
    const tools = c.args[c.args.indexOf('--allowedTools') + 1];
    assert.ok(tools.includes('Bash(kioku check:*)'));
    assert.ok(tools.includes('Bash(kioku promote:*)'));
    assert.equal((tools.match(/kioku/g) || []).length, 2, 'aucune autre sous-commande de la gate');
    assert.equal(c.path.split(path.delimiter)[0], CORE_BIN, 'bin/ du core en tete du PATH : kioku s appelle par son nom');
    assert.ok(c.args.includes('--verbose'));
  });

  test('stdin : une question avec guillemets, & et saut de ligne arrive intacte, jamais en argument', async () => {
    const q = 'Dis "bonjour" & au revoir\nligne 2';
    await run(makeAsker(), q);
    const [c] = calls();
    assert.equal(c.stdin, `/query ${q}`);
    assert.ok(!c.args.some((a) => a.includes('bonjour')));
  });

  test('suivi : /query au premier tour seulement, --session-id puis --resume du meme fil', async () => {
    const asker = makeAsker();
    const first = await run(asker, 'Premiere question');
    await run(asker, 'oui', first.final.thread);
    const [a, b] = calls();
    assert.equal(a.stdin, '/query Premiere question');
    assert.equal(a.args[a.args.indexOf('--session-id') + 1], first.final.thread);
    assert.equal(b.stdin, 'oui');
    assert.equal(b.args[b.args.indexOf('--resume') + 1], first.final.thread);
    assert.ok(!b.args.includes('--session-id'));
  });

  test('fil inconnu : un identifiant qui n est pas le fil courant ouvre un fil neuf', async () => {
    const asker = makeAsker();
    const { final } = await run(asker, 'Q', '11111111-1111-1111-1111-111111111111');
    const [c] = calls();
    assert.ok(!c.args.includes('--resume'));
    assert.notEqual(final.thread, '11111111-1111-1111-1111-111111111111');
    assert.equal(c.stdin, '/query Q');
  });

  test('garde non declaree : echec ferme, aucun processus lance', async () => {
    rmSync(path.join(vault, '.claude'), { recursive: true, force: true });
    const asker = makeAsker();
    const { final } = await run(asker, 'Q');
    assert.equal(final.type, 'error');
    assert.equal(final.code, 'no-guard');
    assert.equal(calls().length, 0);
    assert.equal(asker.isBusy(), false);
  });

  test('occupe : un second tour pendant le premier est refuse sans lancer de processus', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const asker = makeAsker();
    let started;
    const running = new Promise((r) => (started = r));
    const first = run(asker, 'Q1', null, { onFirstText: (h) => started(h) });
    const second = await run(asker, 'Q2');
    assert.equal(second.refused, true);
    assert.equal(asker.isBusy(), true);
    const handle = await running; // le faux claude a lu sa question et l'a consignee
    handle.cancel();
    await first;
    assert.equal(calls().length, 1);
  });

  test('annulation : tue le processus, rend cancelled, libere le verrou et efface le fil courant', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const asker = makeAsker();
    const { events, final } = await run(asker, 'Q', null, { onFirstText: (h) => h.cancel() });
    assert.equal(final.type, 'cancelled');
    assert.ok(events.some((e) => e.type === 'text'));
    assert.equal(asker.isBusy(), false);
    assert.equal(asker.currentThread, null);
  });

  test('echec : code 1 sans resultat rend error et efface le fil courant', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'fail';
    const asker = makeAsker();
    const { final } = await run(asker, 'Q');
    assert.equal(final.type, 'error');
    assert.equal(final.code, 'session');
    assert.equal(asker.currentThread, null);
    assert.equal(asker.isBusy(), false);
  });

  test('claude absent : error lisible, verrou libere', async () => {
    const asker = createAsker({ vaultRoot: vault, domain: 'pro', command: path.join(vault, 'claude-introuvable') });
    const { final } = await run(asker, 'Q');
    assert.equal(final.type, 'error');
    assert.equal(final.code, 'spawn');
    assert.equal(asker.isBusy(), false);
  });

  test('killAll : tue la session active a l arret du serveur', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const asker = makeAsker();
    const p = run(asker, 'Q', null, { onFirstText: () => asker.killAll() });
    const { final } = await p;
    assert.equal(final.type, 'cancelled');
  });

  test('domaine invalide refuse a la creation', () => {
    assert.throws(() => createAsker({ vaultRoot: vault, domain: 'tout' }));
  });
});

describe('U1 : traduction des lignes stream-json', () => {
  const ctx = () => ({ vaultRoot: vault, domain: 'pro' });

  test('ligne non JSON ignoree', () => {
    assert.deepEqual(translateLine('pas du json', ctx()), []);
  });

  test('lecture hors wiki/<D>/ ignoree, lecture sous wiki/<D>/ (index, log compris) comptee', () => {
    const line = (file) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });
    assert.deepEqual(translateLine(line(path.join(vault, '.candidats', 'wiki', 'pro', 'a.md')), ctx()), []);
    assert.deepEqual(translateLine(line(path.join(vault, 'wiki', 'perso', 'a.md')), ctx()), []);
    assert.deepEqual(translateLine(line(path.join(vault, 'wiki', 'pro', 'log.md')), ctx()), [{ type: 'read', path: 'log.md' }]);
    assert.deepEqual(translateLine(line('wiki/pro/people/a.md'), ctx()), [{ type: 'read', path: 'people/a.md' }]);
  });

  test('message de sous-agent ignore', () => {
    const line = JSON.stringify({ type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
    assert.deepEqual(translateLine(line, ctx()), []);
  });

  test('resultat en erreur marque ok=false', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
    assert.deepEqual(translateLine(line, ctx()), [{ type: 'result', ok: false, markdown: '' }]);
  });
});
