#!/usr/bin/env node
/**
 * Depose les fils de mail des comptes declares dans inbox/ (lance par run.mjs, ou seul).
 *
 *   node tools/mail-sync/fetch-mail.mjs --since 2026-11-01 [--account <id>] [--dry-run] [--max-pdf-mb N] [--max-threads N]
 *   node tools/mail-sync/fetch-mail.mjs --skip <thread_id>      ecarte un fil pour de bon (seen.json « thread: »), repetable
 *
 * Le coffre vise est CLAUDE_PROJECT_DIR (pose par run.mjs). Les comptes viennent de modules.mail.accounts. Un compte
 * en echec (jeton absent, refresh refuse, libelle introuvable) est signale et les autres continuent ; le code de sortie
 * est alors 1, et le circuit s'arrete avant le tri. Ce qui a ete depose reste dans inbox/ pour le lancement suivant.
 */

import { loadConfig, vaultRoot } from '../vault-config.mjs';
import { captureAccount, DEFAULT_MAX_PDF_MB, DEFAULT_MAX_THREADS } from './capture.mjs';
import { addToRegistry } from './dedup.mjs';
import { accessToken } from './oauth.mjs';
import { createGmail } from './providers/gmail.mjs';

const PROVIDERS = { gmail: (account) => createGmail({ token: ({ force } = {}) => accessToken(account.id, { force }) }) };

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VAULT = vaultRoot(undefined);
const fail = (msg) => {
  console.error(`fetch-mail : ${msg}`);
  process.exit(1);
};

let cfg;
try {
  cfg = loadConfig(VAULT);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const mail = cfg.modules.mail;
if (!mail) fail('module mail non declare dans kioku.config.json (kioku init --mail, ou modules.mail a la main)');

const skips = argv.flatMap((a, i) => (a === '--skip' ? [argv[i + 1] ?? ''] : []));
for (const id of skips) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`--skip attend un identifiant de fil Gmail, recu "${id}"`);
  if (argv.includes('--dry-run')) console.log(`[dry-run] ecarterait le fil ${id}`);
  else console.log(addToRegistry(VAULT, { id: `thread:${id}`, domaine: 'ecarte' }) ? `ecarte   fil ${id} (seen.json)` : `deja ecarte : fil ${id}`);
}

const only = opt('--account');
const accounts = (mail.accounts ?? []).filter((a) => !only || a.id === only);
if (only && !accounts.length) fail(`compte inconnu : ${only} (declares : ${(mail.accounts ?? []).map((a) => a.id).join(', ') || 'aucun'})`);
if (!accounts.length) {
  console.log('Aucun compte mail declare (modules.mail.accounts) : rien a capter.');
  process.exit(0);
}
const maxMb = Number(opt('--max-pdf-mb') ?? mail.max_pdf_mb ?? DEFAULT_MAX_PDF_MB);
if (!(maxMb > 0)) fail('--max-pdf-mb attend un nombre positif');
const maxThreads = Number(opt('--max-threads') ?? DEFAULT_MAX_THREADS);
if (!(Number.isInteger(maxThreads) && maxThreads > 0)) fail('--max-threads attend un entier positif');
const since = opt('--since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

// Tous les jetons d'abord : un jeton absent, revoque ou expire arrete tout AVANT le premier depot (aucun depot partiel
// pour cette cause). Une panne en cours de route (reseau, quota) peut encore laisser les comptes deja captes dans
// l'entrant : ils n'y sont tries que par le circuit mail (owners.mjs), au lancement suivant.
{
  const refused = [];
  for (const account of accounts) {
    if (!PROVIDERS[account.provider]) continue;
    try {
      await accessToken(account.id);
    } catch (error) {
      refused.push(`compte ${account.id} : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (refused.length) {
    for (const line of refused) console.error(line);
    fail('aucun depot : corrige le ou les jetons ci-dessus, puis relance');
  }
}

let failed = 0;
for (const account of accounts) {
  const make = PROVIDERS[account.provider];
  try {
    if (!make) throw new Error(`fournisseur inconnu : ${account.provider}`);
    await captureAccount({ vault: VAULT, account, provider: make(account), since, dryRun: argv.includes('--dry-run'), maxPdfBytes: maxMb * 1024 * 1024, maxThreads });
  } catch (error) {
    failed++;
    console.error(`compte ${account.id} : ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 1 : 0);
