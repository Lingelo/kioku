#!/usr/bin/env node
/**
 * Lance Claude Code dans le coffre avec un mode et un domaine. Meme script sur Windows, macOS et Linux
 * (Node est deja requis par la garde).
 *
 *   node tools/vault.mjs                          query : demande le domaine parmi ceux de kioku.config.json
 *   node tools/vault.mjs --domain perso           query / perso, sans question
 *   node tools/vault.mjs --mode ingest --domain pro
 *   node tools/vault.mjs --mode triage
 *   node tools/vault.mjs --lint --domain perso    query / perso, demarre sur /lint perso
 *   node tools/vault.mjs --domain pro -- --resume  (ce qui suit -- est passe a claude)
 *
 * La session demarre sur la tache de son mode, pour ne pas la ressaisir : ingest -> /ingest, triage -> /triage,
 * --lint -> /lint <domaine> (en mode query : le lint lit l'or, pas le brut). Les mots libres sont ajoutes a la
 * commande (`--mode ingest --domain perso articles/x.md` -> /ingest articles/x.md) ; en query, ils forment la
 * question. Pas de texte de depart quand on reprend une session (--resume, --continue).
 *
 * La garde Kioku lit VAULT_MODE et VAULT_DOMAIN dans l'environnement : elles decident de
 * ce qui est lisible. Le domaine est fixe pour toute la session : pour en changer, fermer et relancer.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCorePath } from './core-path.mjs';
import { skill } from './names.mjs';
import { startupRefusal } from './startup-guard.mjs';
import { domainsOf, isVault, vaultRoot } from './vault-config.mjs';

// Le coffre : le dossier courant (scripts npm du coffre) ou CLAUDE_PROJECT_DIR, jamais l'emplacement du core.
const ROOT = vaultRoot(undefined);
const MODES = ['query', 'ingest', 'triage', 'setup'];
// Modes sans domaine : triage (la garde n'ouvre que inbox/) et setup (aucun contenu de domaine, la configuration seule).
const NO_DOMAIN = ['triage', 'setup'];

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const passthrough = sep === -1 ? [] : argv.slice(sep + 1);

function opt(names) {
  const i = own.findIndex(a => names.includes(a));
  return i === -1 ? undefined : own[i + 1];
}
// Mots libres : tout ce qui n'est ni une option du lanceur ni sa valeur.
const VALUED = ['--mode', '-m', '--domain', '-d'];
const FLAGS = ['--lint', '--help', '-h'];
const words = own.filter((a, i) => !VALUED.includes(a) && !VALUED.includes(own[i - 1]) && !FLAGS.includes(a));
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Les domaines viennent de la configuration du coffre (kioku.config.json), comme pour la garde.
if (!isVault(ROOT)) fail(`${ROOT} n'est pas un coffre (kioku.config.json absent ou invalide) : lance le lanceur depuis la racine du coffre.`);
let DOMAINS;
try {
  DOMAINS = domainsOf(ROOT);
} catch (error) {
  fail(`Coffre : ${error instanceof Error ? error.message : String(error)}`);
}

if (own.includes('--help') || own.includes('-h')) {
  console.log(`Usage : node tools/vault.mjs [--mode ${MODES.join('|')} | --lint] [--domain ${DOMAINS.join('|')}] [mots…] [-- <options claude>]`);
  process.exit(0);
}

const lint = own.includes('--lint');
const mode = opt(['--mode', '-m']) ?? 'query';
let domain = opt(['--domain', '-d']);
if (!MODES.includes(mode)) fail(`Mode inconnu : ${mode} (attendu : ${MODES.join(', ')})`);
if (lint && mode !== 'query') fail('--lint se lance en mode query (il lit l\'or, pas le brut) : retire --mode.');
const unknown = words.find(w => w.startsWith('-'));
if (unknown) fail(`Option inconnue : ${unknown} (les options de claude vont apres --)`);
if (domain !== undefined && !DOMAINS.includes(domain)) fail(`Domaine inconnu : ${domain} (attendu : ${DOMAINS.join(', ')})`);
if (mode === 'setup' && domain !== undefined) fail('--mode setup se lance sans --domain : la session ne lit aucun domaine.');

// Le triage lit l'inbox, sans domaine ; le setup ne lit aucun domaine. Sinon, si le domaine n'est pas donne, on le
// demande plutot que de le supposer : une question perso posee en session pro serait refusee par la garde.
// Un seul domaine declare : pas de question. Plusieurs : nom ou numero, Entree = le premier declare.
if (domain === undefined && !NO_DOMAIN.includes(mode)) {
  if (DOMAINS.length === 1) domain = DOMAINS[0];
  else {
    if (!process.stdin.isTTY) fail(`Domaine non precise et pas de terminal interactif : ajoute --domain ${DOMAINS.join('|')}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const menu = DOMAINS.map((d, i) => `[${i + 1}] ${d}`).join(', ');
    while (domain === undefined) {
      const a = (await rl.question(`Domaine a interroger : ${menu} ? (Entree = ${DOMAINS[0]}) `)).trim().toLowerCase();
      if (a === '') domain = DOMAINS[0];
      else if (DOMAINS.includes(a)) domain = a;
      else if (/^\d+$/.test(a) && DOMAINS[Number(a) - 1]) domain = DOMAINS[Number(a) - 1];
    }
    rl.close();
  }
}
// Triage : la garde n'ouvre que inbox/, le domaine ne sert qu'a la declarer valide. Setup : aucun domaine pose.
if (mode === 'triage') domain ??= DOMAINS[0];

// Texte de depart : la tache du mode, pour ne pas la ressaisir a chaque session.
const resuming = passthrough.some(a => ['--resume', '-r', '--continue', '-c'].includes(a));
const task = lint ? `${skill('lint')} ${domain}` : mode === 'query' ? '' : skill(mode);
const start = resuming ? '' : [task, ...words].join(' ').trim();
// Sous Windows, shell: true recolle les arguments sans guillemets : on protege le texte qui contient des espaces.
const quote = (s) => (process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : s);

// Une variable heritee du terminal ne doit pas reouvrir un domaine en setup : on pose les deux, on retire l'autre.
// bin/ du core en tete du PATH : la session appelle la gate par `kioku <commande>`.
const env = { ...withCorePath(process.env), VAULT_MODE: mode };
if (domain === undefined) delete env.VAULT_DOMAIN;
else env.VAULT_DOMAIN = domain;

// Pas de session sans garde : hook du projet, ou plugin kioku installe pour ce coffre au SHA epingle.
const refusal = startupRefusal(ROOT);
if (refusal) fail(`Session refusee : ${refusal}`);

console.log(`Coffre : mode=${mode}${domain ? ` domaine=${domain}` : ''}${start ? ` — demarrage : ${start}` : ''}`);
const child = spawn('claude', start ? [...passthrough, quote(start)] : passthrough, {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32', // claude est un .cmd sous Windows
});
child.on('error', e => fail(`Impossible de lancer claude : ${e.message}`));
child.on('exit', code => process.exit(code ?? 0));
