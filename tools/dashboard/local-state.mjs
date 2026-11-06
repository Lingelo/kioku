/**
 * tools/dashboard/local-state.mjs
 *
 * Lecture des etats locaux a la machine (circuit Plaud gitignore et entrant non classe).
 * Distingue l'absence (unknown) de la vacuite (empty / count: 0) sans jamais muter l'etat.
 * Tout le resultat est explicitement marque `scope: 'local'` (R12, R13, KTD4).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAlive } from '../connectors/lock.mjs';

/**
 * Lit un fichier JSON de maniere sure, sans lever d'exception.
 */
const safeReadJson = (filePath) => {
  if (!existsSync(filePath)) {
    return { exists: false, data: null, error: null };
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return { exists: true, data, error: null };
  } catch (error) {
    return { exists: true, data: null, error: error.message };
  }
};

/**
 * Lit les etats locaux de la machine pour le tableau de bord.
 */
/** Les circuits de capture et leur dossier d'etat (relatif au coffre). */
const CIRCUITS = [
  ['plaud', 'tools/plaud-sync'],
  ['mail', 'tools/mail-sync'],
];

export const readLocalState = (vaultRoot, domain = null) => {
  const stateDir = path.join(vaultRoot, 'tools', 'plaud-sync');
  const snapshotFile = path.join(stateDir, '.snapshot.json');
  // Le verrou commun du coffre (tools/connectors/lock.mjs) ; l'ancien emplacement, tenu en miroir, en repli.
  const canonicalLock = path.join(vaultRoot, 'tools', 'connectors', '.lock.json');
  const lockFile = existsSync(canonicalLock) ? canonicalLock : path.join(stateDir, '.lock.json');
  const arbitrationDir = path.join(vaultRoot, 'inbox', 'a-trancher');
  const inboxDir = path.join(vaultRoot, 'inbox');

  // 1. Files d'attente d'ingestion des circuits (.queue.json de Plaud et du mail), additionnees ; byCircuit les detaille.
  const queues = CIRCUITS.map(([name, rel]) => [name, safeReadJson(path.join(vaultRoot, ...rel.split('/'), '.queue.json'))]).filter(([, r]) => r.exists);
  let queueState;
  const badQueue = queues.find(([, r]) => r.error || !Array.isArray(r.data));
  if (!queues.length) {
    queueState = { status: 'unknown', count: null };
  } else if (badQueue) {
    queueState = { status: 'corrupt', count: null, error: badQueue[1].error ?? 'Format de file invalide (attendu tableau)' };
  } else {
    const byCircuit = Object.fromEntries(queues.map(([name, r]) => [name, r.data.length]));
    const count = Object.values(byCircuit).reduce((a, b) => a + b, 0);
    queueState = { status: count === 0 ? 'empty' : 'present', count, byCircuit };
  }

  // 2. Photo du bronze (.snapshot.json)
  // Cloisonnement strict pro/perso : si un domaine est specifie, n'exposer que ce domaine
  // Un seul tri a la fois (verrou commun) : la photo est celle du circuit qui trie, s'il y en a une.
  const snapRead = [snapshotFile, path.join(vaultRoot, 'tools', 'mail-sync', '.snapshot.json')].map(safeReadJson).find((r) => r.exists) ?? { exists: false };
  let snapshotState;
  if (!snapRead.exists) {
    snapshotState = { status: 'unknown', counts: null };
  } else if (snapRead.error) {
    snapshotState = { status: 'corrupt', counts: null, error: snapRead.error };
  } else if (typeof snapRead.data === 'object' && snapRead.data !== null) {
    const counts = {};
    if (domain) {
      if (domain in snapRead.data) {
        counts[domain] = Array.isArray(snapRead.data[domain]) ? snapRead.data[domain].length : 0;
      }
    } else {
      for (const [dom, list] of Object.entries(snapRead.data)) {
        counts[dom] = Array.isArray(list) ? list.length : 0;
      }
    }
    snapshotState = { status: 'present', counts };
  } else {
    snapshotState = { status: 'corrupt', counts: null, error: 'Format de snapshot invalide' };
  }

  // 3. Verrou du coffre (circuits de capture, commandes de la gate) : qui le tient, s'il le dit
  const lockRead = safeReadJson(lockFile);
  let lockState;
  if (!lockRead.exists) {
    lockState = { status: 'unknown', pid: null };
  } else if (lockRead.error) {
    lockState = { status: 'corrupt', pid: null, error: lockRead.error };
  } else {
    const held = lockRead.data;
    const pid = Number.isInteger(held?.pid) ? held.pid : null;
    if (pid && isAlive(pid)) {
      lockState = { status: 'active', pid, started: held.started, owner: typeof held.owner === 'string' ? held.owner : null };
    } else {
      lockState = { status: 'stale', pid, started: held?.started, owner: typeof held?.owner === 'string' ? held.owner : null };
    }
  }

  // 4. Entrant en attente d'arbitrage (inbox/a-trancher/)
  // On compte les fichiers sans lire leur contenu ni exposer leurs noms (confidentialite et indetermination du domaine)
  let inboxArbitrationState;
  if (!existsSync(arbitrationDir)) {
    inboxArbitrationState = { status: 'unknown', count: null };
  } else {
    try {
      const entries = readdirSync(arbitrationDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== '_raisons.md');
      inboxArbitrationState = {
        status: entries.length === 0 ? 'empty' : 'present',
        count: entries.length,
      };
    } catch {
      inboxArbitrationState = { status: 'unknown', count: null };
    }
  }

  // 5. Entrant brut (inbox/)
  let inboxRawState;
  if (!existsSync(inboxDir)) {
    inboxRawState = { status: 'unknown', count: null };
  } else {
    try {
      const files = readdirSync(inboxDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name);
      inboxRawState = {
        status: files.length === 0 ? 'empty' : 'present',
        count: files.length,
      };
    } catch {
      inboxRawState = { status: 'unknown', count: null };
    }
  }

  return {
    scope: 'local',
    queue: queueState,
    snapshot: snapshotState,
    lock: lockState,
    inboxArbitration: inboxArbitrationState,
    inboxRaw: inboxRawState,
  };
};
