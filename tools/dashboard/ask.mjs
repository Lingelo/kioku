/**
 * tools/dashboard/ask.mjs
 *
 * Lanceur des questions de l'onglet 問 Question : un tour = une session `claude -p` sous la garde,
 * sur le modele de `session()` dans tools/plaud-sync/run.mjs, mais asynchrone et en flux.
 *
 * Garanties (plan 2026-10-02-2218, KTD1 a KTD9) :
 * - mode `query` et domaine du serveur dans l'environnement : la garde decide de ce qui est lu et ecrit
 * - `cwd` et `CLAUDE_PROJECT_DIR` a la racine du coffre, sinon le hook de garde ne se charge pas ;
 *   echec ferme si aucune garde n'est declaree (hook du projet ou plugin kioku active, comme `kioku doctor`)
 * - question sur l'entree standard, jamais en argument (sous Windows, les arguments passent par un shell)
 * - `/query` au premier tour seulement : les suivis sont une conversation, comme en CLI
 * - un seul fil courant, cree par ce serveur ; une seule session active a la fois
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { withCorePath } from '../core-path.mjs';
import { registeredGuard } from '../kioku.mjs';
import { skill } from '../names.mjs';
import { assertDomain } from '../vault-config.mjs';

const WIN = process.platform === 'win32';

// Outils de la session : de quoi lire l'or, tenir le journal et l'index, et filer avec /save.
// Plus etroit que TOOLS de Plaud : la garde ne filtre pas les sous-commandes de la gate, et le wiki
// contient des transcriptions de tiers qui pourraient porter une instruction injectee.
export const ASK_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'Bash(kioku check:*)', 'Bash(kioku promote:*)'].join(',');

const realRoots = new Map();
const realRoot = (root) => {
  if (!realRoots.has(root)) {
    try {
      realRoots.set(root, realpathSync(root));
    } catch {
      realRoots.set(root, root);
    }
  }
  return realRoots.get(root);
};

const quote = (a) => (WIN ? `"${String(a).replace(/"/g, '\\"')}"` : a);

/**
 * Traduit une ligne `stream-json` en evenements de l'onglet. Les messages d'un sous-agent
 * (parent_tool_use_id renseigne, ex. le relecteur de /save) sont ignores.
 *
 * @returns {Array<object>} evenements { type: 'read', path } | { type: 'text', text } | { type: 'result', ... }
 */
export const translateLine = (line, { vaultRoot, domain }) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!msg || typeof msg !== 'object' || msg.parent_tool_use_id) return [];

  if (msg.type === 'stream_event') {
    const delta = msg.event?.delta;
    if (msg.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
      return [{ type: 'text', text: delta.text }];
    }
    return [];
  }

  if (msg.type === 'assistant') {
    const out = [];
    // claude rapporte des chemins resolus : un coffre atteint par un lien (ex. /var -> /private/var
    // sous macOS) doit etre reconnu sous ses deux formes.
    const wikiDirs = [...new Set([vaultRoot, realRoot(vaultRoot)])].map((r) => path.join(r, 'wiki', domain) + path.sep);
    for (const block of msg.message?.content ?? []) {
      if (block?.type !== 'tool_use' || block.name !== 'Read') continue;
      const file = block.input?.file_path;
      if (typeof file !== 'string') continue;
      const abs = path.resolve(vaultRoot, file);
      const dir = wikiDirs.find((d) => abs.startsWith(d));
      if (dir) out.push({ type: 'read', path: abs.slice(dir.length).split(path.sep).join('/') });
    }
    return out;
  }

  if (msg.type === 'result') {
    return [{ type: 'result', ok: !msg.is_error && msg.subtype === 'success', markdown: typeof msg.result === 'string' ? msg.result : '' }];
  }
  return [];
};

/**
 * Cree le lanceur d'un serveur. Un seul par processus serveur : il porte le fil courant et le verrou.
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot - racine absolue du coffre
 * @param {string} opts.domain - domaine du serveur, declare dans la configuration (jamais celui de la requete)
 * @param {string} [opts.command='claude'] - commande a lancer (remplacable en test)
 * @param {string[]} [opts.commandArgs=[]] - arguments places avant ceux de la session (ex. script du faux claude)
 */
export const createAsker = ({ vaultRoot, domain, command = 'claude', commandArgs = [] }) => {
  assertDomain(vaultRoot, domain);
  let currentThread = null;
  let active = null; // { child, cancel }

  const isBusy = () => active !== null;

  /**
   * Lance un tour. `onEvent` recoit, dans l'ordre : read*, text*, puis exactement un evenement final
   * parmi done | error | cancelled.
   *
   * @returns {{ cancel: () => void, finished: Promise<void> } | null} null si une session est deja active
   */
  const ask = (question, threadId, onEvent) => {
    if (active) return null;

    const emitFinal = (() => {
      let sent = false;
      return (evt) => {
        if (sent) return;
        sent = true;
        active = null;
        onEvent(evt);
      };
    })();

    // La garde declaree, pas un chemin suppose : apres la bascule, elle vit dans le plugin, plus dans le coffre.
    if (!registeredGuard(vaultRoot).guard) {
      emitFinal({ type: 'error', code: 'no-guard', message: 'Garde du coffre introuvable : session refusee.' });
      return { cancel: () => {}, finished: Promise.resolve() };
    }

    const resume = threadId && threadId === currentThread;
    const thread = resume ? currentThread : randomUUID();
    currentThread = thread;
    const prompt = resume ? question : `${skill('query')} ${question}`;

    const args = [
      ...commandArgs,
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ASK_TOOLS,
      ...(resume ? ['--resume', thread] : ['--session-id', thread]),
    ];

    const started = Date.now();
    const pages = new Set();
    let finalMarkdown = null;
    let resultOk = false;
    let cancelled = false;

    let child;
    try {
      child = spawn(command, WIN ? args.map(quote) : args, {
        cwd: vaultRoot,
        env: { ...withCorePath(process.env), CLAUDE_PROJECT_DIR: vaultRoot, VAULT_MODE: 'query', VAULT_DOMAIN: domain },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: WIN, // claude est un .cmd sous Windows
      });
    } catch (err) {
      currentThread = null;
      emitFinal({ type: 'error', code: 'spawn', message: 'Session impossible : Claude Code introuvable.' });
      return { cancel: () => {}, finished: Promise.resolve() };
    }

    let resolveFinished;
    const finished = new Promise((r) => (resolveFinished = r));
    active = { child };

    const fail = (code, message) => {
      currentThread = null;
      emitFinal({ type: 'error', code, message });
    };

    child.on('error', (err) => {
      fail(err?.code === 'ENOENT' ? 'spawn' : 'session', err?.code === 'ENOENT' ? 'Session impossible : Claude Code introuvable.' : 'La session a echoue.');
    });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || cancelled) continue;
        for (const evt of translateLine(line, { vaultRoot, domain })) {
          if (evt.type === 'read') {
            if (!pages.has(evt.path)) {
              pages.add(evt.path);
              onEvent(evt);
            }
          } else if (evt.type === 'text') {
            onEvent(evt);
          } else if (evt.type === 'result') {
            finalMarkdown = evt.markdown;
            resultOk = evt.ok;
          }
        }
      }
    });
    // La sortie d'erreur n'est jamais recopiee vers la page : elle peut contenir des chemins ou du contenu.
    child.stderr.resume();

    child.on('close', (code) => {
      if (cancelled) {
        currentThread = null;
        emitFinal({ type: 'cancelled' });
      } else if (code === 0 && resultOk && finalMarkdown !== null) {
        emitFinal({ type: 'done', thread, markdown: finalMarkdown, durationMs: Date.now() - started, pagesRead: pages.size });
      } else {
        fail('session', 'La session a echoue.');
      }
      resolveFinished();
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const cancel = () => {
      if (cancelled || !active || active.child !== child) return;
      cancelled = true;
      child.kill();
    };
    active.cancel = cancel;
    return { cancel, finished };
  };

  /** Arret du serveur : tue la session active, s'il y en a une. */
  const killAll = () => {
    if (active?.cancel) active.cancel();
  };

  return { ask, isBusy, killAll, get currentThread() { return currentThread; } };
};
