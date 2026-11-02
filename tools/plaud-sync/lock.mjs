/**
 * Verrou du circuit Plaud : un seul `run.mjs` a la fois sur un coffre donne.
 *
 * Pourquoi. L'ingestion d'une source dure des minutes, et la file (`.queue.json`) ne perd son entree
 * qu'une fois la fiche argent ecrite (`pending.mjs list`). Un second lancement pendant ce temps relit
 * la file, y retrouve la meme source et lance une DEUXIEME session d'ingestion dessus : les deux
 * ecrivent les memes candidates, se relisent l'une l'autre a la gate sur une empreinte qui bouge, et
 * les deux fichiers tenus en ajout (`index.md`, `log.md`) recoivent chacun deux entrees. Le depot et
 * le tri, eux, sont deja dedupliques (`dedup.mjs`) : seule l'ingestion manquait de garde-fou.
 *
 * Le verrou porte le PID du lanceur. Un verrou dont le processus n'existe plus (run tue, machine
 * redemarree) est repris tout seul : rien a supprimer a la main apres un `kill`. Un verrou illisible
 * (fichier tronque par un arret brutal) est traite comme perime, pour la meme raison.
 *
 * Limite, dite : le PID ne vaut que sur une machine. Deux coffres synchronises qui tourneraient en
 * meme temps sur deux postes ne se voient pas — le verrou est local, comme `.queue.json`.
 *
 * Etat local, non versionne : `tools/plaud-sync/.lock.json` (voir .gitignore).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** L'etat suit le coffre vise, pas l'emplacement du script — meme regle que pending.mjs (--vault). */
export const lockDir = (vault) => path.join(vault, 'tools', 'plaud-sync');
export const lockPath = (vault) => path.join(lockDir(vault), '.lock.json');

/** Le processus existe-t-il ? EPERM = il existe mais appartient a quelqu'un d'autre : vivant. */
export const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const readLock = (file) => {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(held?.pid) ? held : null;
  } catch {
    return null; // absent, tronque, illisible : traite comme perime
  }
};

/**
 * Prend le verrou. Retourne `{ ok: true, stale }` — `stale` porte le verrou perime repris, ou null —
 * ou `{ ok: false, held }` si un autre lanceur vivant le detient.
 */
export const acquire = (vault, { pid = process.pid, now = () => new Date().toISOString() } = {}) => {
  const file = lockPath(vault);
  const mine = JSON.stringify({ pid, started: now() }, null, 1);
  mkdirSync(lockDir(vault), { recursive: true });
  let stale = null;
  // Deux tours au plus : creation, puis reprise d'un verrou perime. Un troisieme echec veut dire
  // qu'un autre lanceur a pris le verrou entre-temps — il est vivant, on lui laisse.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      return { ok: true, stale };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = readLock(file);
      if (held && held.pid !== pid && isAlive(held.pid)) return { ok: false, held };
      stale = held;
      rmSync(file, { force: true });
    }
  }
  return { ok: false, held: readLock(file) ?? { pid: null } };
};

/** Rend le verrou, mais seulement s'il est a nous : un verrou repris par un autre ne se supprime pas. */
export const release = (vault, pid = process.pid) => {
  const file = lockPath(vault);
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
};
