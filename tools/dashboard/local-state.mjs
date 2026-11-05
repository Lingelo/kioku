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
export const readLocalState = (vaultRoot, domain = null) => {
  const stateDir = path.join(vaultRoot, 'tools', 'plaud-sync');
  const queueFile = path.join(stateDir, '.queue.json');
  const snapshotFile = path.join(stateDir, '.snapshot.json');
  const lockFile = path.join(stateDir, '.lock.json');
  const arbitrationDir = path.join(vaultRoot, 'inbox', 'a-trancher');
  const inboxDir = path.join(vaultRoot, 'inbox');

  // 1. File d'attente d'ingestion Plaud (.queue.json)
  const qRead = safeReadJson(queueFile);
  let queueState;
  if (!qRead.exists) {
    queueState = { status: 'unknown', count: null };
  } else if (qRead.error) {
    queueState = { status: 'corrupt', count: null, error: qRead.error };
  } else if (Array.isArray(qRead.data)) {
    queueState = {
      status: qRead.data.length === 0 ? 'empty' : 'present',
      count: qRead.data.length,
    };
  } else {
    queueState = { status: 'corrupt', count: null, error: 'Format de file invalide (attendu tableau)' };
  }

  // 2. Photo du bronze (.snapshot.json)
  // Cloisonnement strict pro/perso : si un domaine est specifie, n'exposer que ce domaine
  const snapRead = safeReadJson(snapshotFile);
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

  // 3. Verrou du circuit Plaud (.lock.json)
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
      lockState = { status: 'active', pid, started: held.started };
    } else {
      lockState = { status: 'stale', pid, started: held?.started };
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
