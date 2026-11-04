/**
 * tools/dashboard/held-read.mjs
 *
 * Lecture de la quarantaine et des candidates a la gate.
 * Liste ce qui attend une decision de l'utilisateur et ce qui est bloque avant l'or.
 * Ne recopie JAMAIS le contenu sensible d'une page retenue (R7, R11, KTD2, KTD10).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readText, walk } from './vault-read.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Nature d'un element de quarantaine : recopie conforme de kindOf (hooks/vault.mjs, regle de `decide`).
 * Le critere est la presence du .md, pas les marqueurs `pointeur`/`flagged` : une page signalee (flag) a un target
 * et pas de .md. Un test compare cette copie a la sortie de `vault.mjs undecided`.
 */
export const quarantineKind = (base, meta) => (!meta.target ? 'pointeur' : existsSync(`${base}.md`) ? 'retenue' : 'signalee');
export const QUARANTINE_ACTIONS = { pointeur: ['drop'], retenue: ['keep', 'correct', 'drop'], signalee: ['keep', 'correct', 'drop'] };
// Noms historiques du champ `type`, gardes pour les lecteurs existants.
const TYPE_OF_KIND = { pointeur: 'held_source', retenue: 'held_page', signalee: 'flagged_page' };
const KIND_LABEL = { pointeur: 'Pointeur (passage écarté à l’ingestion, aucune page)', retenue: 'Page retenue par la gate', signalee: 'Page de l’or signalée' };
export const quarantineLabel = (kind) => KIND_LABEL[kind] ?? 'En quarantaine';

/**
 * Calcule l'empreinte sha256 d'une candidate exactement comme la gate (hooks/vault.mjs, empreinte des verdicts).
 * Pour une candidate de type source, l'empreinte integre la fiche argent si elle existe.
 */
export const computeCandidateHash = (vaultRoot, domain, folder, slug, text = null) => {
  const normText = text !== null ? text.replace(/\r\n/g, '\n') : readText(path.join(vaultRoot, '.candidats', 'wiki', domain, folder, `${slug}.md`));
  let silverText = '';
  if (folder === 'sources') {
    const silverPath = path.join(vaultRoot, 'silver', domain, `${slug}.md`);
    if (existsSync(silverPath)) {
      silverText = readText(silverPath);
    }
  }
  return sha(`${normText}\u0000${silverText}`);
};

/**
 * Lit la quarantaine et les candidates en attente pour un domaine donne.
 */
export const readHeldAndCandidates = (vaultRoot, domain) => {
  const qDir = path.join(vaultRoot, 'quarantine', domain);
  const candidatesRoot = path.join(vaultRoot, '.candidats', 'wiki', domain);
  const verdictsDir = path.join(vaultRoot, '.verdicts');

  // 1. Quarantaine du domaine
  const quarantine = [];
  if (existsSync(qDir)) {
    const jsonFiles = readdirSync(qDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const f of jsonFiles) {
      const id = f.slice(0, -5);
      const jsonPath = path.join(qDir, f);
      try {
        const meta = JSON.parse(readText(jsonPath));
        const kind = quarantineKind(path.join(qDir, id), meta);
        const type = TYPE_OF_KIND[kind];
        const target = meta.target ?? meta.raw ?? '';

        quarantine.push({
          id,
          domain,
          file: path.relative(vaultRoot, jsonPath),
          code: meta.code ?? 'inconnu',
          date: meta.at ?? null,
          target,
          raw: meta.raw ?? null,
          note: meta.note ?? null,
          type,
          kind,
          actions: QUARANTINE_ACTIONS[kind],
          // Un pointeur n'admet que drop (sans effet sur les pages). Pour une page retenue ou signalee, drop
          // supprime ou sort la page : aucune action par defaut, la commande copiee sans action est refusee par decide.
          command: kind === 'pointeur' ? `kioku decide ${domain} ${id} drop` : `kioku decide ${domain} ${id}`,
        });
      } catch {
        // Ignorer les fichiers JSON corrompus
      }
    }
  }

  // 2. Candidates du domaine (.candidats/wiki/<domain>/<folder>/<slug>.md)
  const candidates = [];
  if (existsSync(candidatesRoot)) {
    const candidateFiles = walk(candidatesRoot);
    for (const f of candidateFiles) {
      const rel = path.relative(candidatesRoot, f).split(path.sep);
      if (rel.length === 2 && rel[1].endsWith('.md')) {
        const folder = rel[0];
        const slug = rel[1].slice(0, -3);
        const relPath = path.relative(vaultRoot, f);
        const hash = computeCandidateHash(vaultRoot, domain, folder, slug);

        const verdictPath = path.join(verdictsDir, `${hash}.json`);
        let verdict = 'none';
        let verdictDetail = null;
        let status = 'awaiting_verdict';
        let command = `kioku check ${relPath}`;

        if (existsSync(verdictPath)) {
          try {
            verdictDetail = JSON.parse(readText(verdictPath));
            verdict = verdictDetail.verdict ?? 'none';
            if (verdict === 'ok') {
              status = 'ready_to_promote';
              command = `kioku promote ${relPath}`;
            } else if (verdict === 'hold') {
              status = 'held_by_reviewer';
              command = `kioku promote ${relPath}`; // La promotion enverra en quarantaine
            }
          } catch {
            verdict = 'none';
          }
        }

        candidates.push({
          relPath,
          domain,
          folder,
          slug,
          hash,
          verdict,
          verdictDetail,
          status,
          command,
        });
      }
    }
  }

  return {
    domain,
    quarantine,
    candidates,
    totalPendingCount: quarantine.length + candidates.length,
  };
};
