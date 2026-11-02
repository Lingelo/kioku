/**
 * tools/dashboard/watch.mjs
 *
 * Surveillance native du coffre ciblee sur le domaine actif.
 *
 * Architecture et garanties (KTD3, KTD4) :
 * - Surveillance recursive sur les dossiers du domaine : wiki, .candidats, quarantine, silver, raw
 * - Surveillance non recursive sur tools/plaud-sync/ (filtree sur queue, snapshot, lock)
 * - Surveillance non recursive sur .verdicts/ (filtree sur les empreintes des candidates du domaine)
 * - Regroupement anti-rebond (debounce) paramétrable (500 ms par defaut)
 * - Re-armement periodique (heartbeat) pour les dossiers absents au demarrage
 * - Silo strict : aucune ecoute sur l'autre domaine ni sur inbox/
 */

import { existsSync, watch } from 'node:fs';
import path from 'node:path';

import { assertDomain } from '../vault-config.mjs';

const PLAUD_STATE_FILES = new Set(['.queue.json', '.snapshot.json', '.lock.json']);
const isPlaudStateFile = (filename) => PLAUD_STATE_FILES.has(filename);

/**
 * Cree une instance de surveillance pour un domaine donne.
 *
 * @param {string} vaultRoot - Racine absolue du coffre
 * @param {string} domain - un domaine declare dans la configuration du coffre
 * @param {object} [options={}] - Options (debounceMs, heartbeatMs, onChanged, getCandidateHashes)
 * @returns {{ready: Promise<void>, close: () => void, arm: () => void, getWatchedPaths: () => string[]}}
 */
export const createWatcher = (vaultRoot, domain, options = {}) => {
  assertDomain(vaultRoot, domain);

  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 500;
  const heartbeatMs = typeof options.heartbeatMs === 'number' ? options.heartbeatMs : 30000;
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {};
  const getCandidateHashes = typeof options.getCandidateHashes === 'function' ? options.getCandidateHashes : () => null;

  // Emplacements specifiques a surveiller
  const recursiveTargets = [
    path.join(vaultRoot, 'wiki', domain),
    path.join(vaultRoot, '.candidats', 'wiki', domain),
    path.join(vaultRoot, 'quarantine', domain),
    path.join(vaultRoot, 'silver', domain),
    path.join(vaultRoot, 'raw', domain),
  ];

  // Le journal du domaine n'est affiche nulle part (fichier catalogue, hors graphe) : une entree
  // de log, ecrite par chaque /query (onglet 問 ou terminal), ne change pas la page. Pas de bandeau.
  // Idem pour ses archives mensuelles (log/<AAAA-MM>.md, ecrites par vault.mjs rotate-log).
  const wikiDir = path.join(vaultRoot, 'wiki', domain);
  const isDomainLog = (targetPath, filename) => {
    if (targetPath !== wikiDir) return false;
    const f = path.normalize(filename);
    return f === 'log.md' || f === 'log.md.tmp' || f === 'log' || (path.dirname(f) === 'log' && /\.md(\.tmp)?$/.test(f));
  };

  const plaudDir = path.join(vaultRoot, 'tools', 'plaud-sync');
  const verdictsDir = path.join(vaultRoot, '.verdicts');

  // Map des watchers actifs : chemin absolu -> FSWatcher
  const activeWatchers = new Map();
  let debounceTimer = null;
  let heartbeatTimer = null;
  let closed = false;

  const triggerChange = () => {
    if (closed) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) {
        onChanged();
      }
    }, debounceMs);
    if (typeof debounceTimer.unref === 'function') {
      debounceTimer.unref();
    }
  };

  const setupWatcher = (targetPath, recursive, filterFn = null) => {
    if (activeWatchers.has(targetPath) || !existsSync(targetPath)) {
      return false;
    }

    try {
      const fsWatcher = watch(targetPath, { recursive }, (eventType, filename) => {
        if (closed) return;
        if (filename && isDomainLog(targetPath, filename)) return;

        // Filtrage optionnel par nom de fichier
        if (filterFn && filename) {
          const basename = path.basename(filename);
          if (!filterFn(basename)) {
            return;
          }
        }

        triggerChange();
      });

      fsWatcher.on('error', (_err) => {
        // En cas de suppression du dossier ou erreur systeme, retirer le watcher sans crasher
        try {
          fsWatcher.close();
        } catch {
          // ignore
        }
        activeWatchers.delete(targetPath);
      });

      activeWatchers.set(targetPath, fsWatcher);
      return true;
    } catch {
      return false;
    }
  };

  // Arme tous les emplacements surveilles existants
  const arm = () => {
    if (closed) return false;
    let newlyAdded = false;

    // 1. Dossiers recursifs du domaine
    for (const dir of recursiveTargets) {
      if (!activeWatchers.has(dir) && setupWatcher(dir, true)) {
        newlyAdded = true;
      }
    }

    // 2. Dossier tools/plaud-sync non recursif
    if (!activeWatchers.has(plaudDir) && setupWatcher(plaudDir, false, isPlaudStateFile)) {
      newlyAdded = true;
    }

    // 3. Dossier .verdicts non recursif filtre par empreintes
    if (!activeWatchers.has(verdictsDir)) {
      const verdictFilter = (filename) => {
        if (!filename.endsWith('.json')) return false;
        const candidateHashes = getCandidateHashes();
        if (!candidateHashes) return true;
        const hash = path.basename(filename, '.json');
        return candidateHashes.has(hash);
      };
      if (setupWatcher(verdictsDir, false, verdictFilter)) {
        newlyAdded = true;
      }
    }

    return newlyAdded;
  };

  // Initialisation au demarrage
  arm();

  // Battement periodique pour re-armer les dossiers apparus
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (closed) return;
      const appeared = arm();
      if (appeared) {
        // L'apparition d'un dossier surveille (ex: premiere mise en quarantaine) constitue un changement
        triggerChange();
      }
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  const close = () => {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const [targetPath, w] of activeWatchers.entries()) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    activeWatchers.clear();
  };

  return {
    ready: Promise.resolve(),
    close,
    arm: () => {
      const appeared = arm();
      if (appeared) triggerChange();
    },
    getWatchedPaths: () => Array.from(activeWatchers.keys()),
  };
};
