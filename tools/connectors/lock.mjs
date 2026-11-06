/**
 * Verrou du coffre, commun a tous les circuits de capture (Plaud aujourd'hui, mail ensuite) et aux commandes qui
 * reecrivent des fichiers tenus en ajout ou la configuration (`kioku rotate-log`, `tag-org`, `tag-raw`, `upgrade
 * --write`, `add-domain`). Un seul de ces lanceurs a la fois sur un coffre donne.
 *
 * Pourquoi. L'ingestion d'une source dure des minutes, et la file (`.queue.json`) ne perd son entree qu'une fois la
 * page or ecrite (`pending.mjs list`). Un second lancement pendant ce temps relit la file, y retrouve la meme source
 * et lance une DEUXIEME session d'ingestion dessus : les deux ecrivent les memes candidates, se relisent l'une l'autre
 * a la gate sur une empreinte qui bouge, et les deux fichiers tenus en ajout (`index.md`, `log.md`) recoivent chacun
 * deux entrees. Deux circuits differents (Plaud puis mail) ont le meme probleme : ils partagent la file, le tri et
 * l'ingestion. D'ou UN verrou par coffre, pas un par connecteur.
 *
 * Le verrou porte le PID du lanceur. Un verrou dont le processus n'existe plus (run tue, machine redemarree) est repris
 * tout seul : rien a supprimer a la main apres un `kill`. Un verrou illisible (fichier tronque par un arret brutal) est
 * traite comme perime, pour la meme raison.
 *
 * Deux fichiers, une transition. Le chemin canonique est `tools/connectors/.lock.json` (etat local du coffre, ignore
 * par le bloc gere du .gitignore). Jusqu'ici le verrou vivait dans `tools/plaud-sync/.lock.json`, et un processus lance
 * par une version anterieure du core (un `run.mjs` en pleine ingestion pendant la mise a jour du plugin, ou un checkout
 * de developpement du core) ne connait que celui-la. Prendre le verrou, c'est donc prendre les DEUX, canonique d'abord :
 *   - un ancien processus qui tient l'ancien fichier bloque un nouveau lanceur (le second tour echoue, le premier est rendu) ;
 *   - un nouveau lanceur qui tient les deux bloque un ancien processus, qui ne regarde que l'ancien fichier.
 * Le tableau de bord lit encore l'ancien fichier (tools/dashboard/local-state.mjs) : le miroir le garde juste.
 * Les deux prises sont des essais sans attente : aucun interblocage possible, au pire un refus.
 *
 * Arret brutal entre les deux ecritures (kill -9, coupure) : le canonique porte un PID mort, le miroir n'existe pas.
 * Le lancement suivant reprend le canonique comme perime et cree le miroir : rien ne bloque. Arret apres les deux : les
 * deux portent le meme PID mort, repris chacun. Seule limite, deja vraie avec un fichier : un PID mort reattribue a un
 * autre processus vivant fait passer le verrou pour tenu, jusqu'a ce que ce processus finisse (le message donne le PID).
 *
 * Retrait du miroir : dans la MEME version que le retrait des shims de tools/plaud-sync/ (lock.mjs, pending.mjs,
 * org-proposals.mjs), et pas avant que tools/dashboard/local-state.mjs et watch.mjs lisent le chemin canonique. A ce
 * moment, aucun code du core ne connait plus l'ancien chemin ; un processus d'une version anterieure encore vivant
 * pendant la mise a jour est le seul cas perdu, et la note de version demande de ne pas mettre a jour en plein circuit.
 * Retirer = supprimer la seconde prise dans acquire() et release() ; le motif `tools/<x>/.lock.json` du .gitignore reste.
 *
 * Limite, dite : le PID ne vaut que sur une machine. Deux coffres synchronises qui tourneraient en meme temps sur deux
 * postes ne se voient pas : le verrou est local, comme `.queue.json`.
 */

import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** L'etat suit le coffre vise, pas l'emplacement du script (--vault). */
export const lockDir = (vault) => path.join(vault, 'tools', 'connectors');
export const lockPath = (vault) => path.join(lockDir(vault), '.lock.json');
/** L'ancien emplacement, tenu en miroir pendant la transition (voir l'en-tete). */
export const legacyLockDir = (vault) => path.join(vault, 'tools', 'plaud-sync');
export const legacyLockPath = (vault) => path.join(legacyLockDir(vault), '.lock.json');

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

/** Le contenu d'un verrou, ou null : absent, tronque, illisible ou sans PID entier = perime. */
export const readLock = (file) => {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(held?.pid) ? held : null;
  } catch {
    return null;
  }
};

const readRaw = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const ageMs = (file) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** Attente synchrone courte (le verrou est pris par du code synchrone). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Un fichier vide, tronque ou sans PID n'est perime que s'il est VIEUX : un fichier tout juste cree peut etre en cours
 * d'ecriture (repli sans `link`, ci-dessous), et le croire perime menerait a supprimer le verrou d'un autre (revue N2).
 */
export const GRACE_MS = 3000;

// Les systemes de fichiers sans liens physiques (FAT, exFAT, certains partages reseau) rendent l'une de ces erreurs.
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EMLINK']);

/**
 * Creation exclusive d'un fichier AVEC son contenu : le contenu est ecrit dans un fichier temporaire, puis lie au nom
 * vise (`link`, qui echoue en EEXIST si le nom est pris). Le fichier n'est donc jamais visible vide ni a moitie ecrit.
 * Repli explicite si le systeme de fichiers refuse les liens : creation `wx` puis ecriture (le fichier peut etre vu
 * vide un instant ; GRACE_MS l'empeche d'etre pris pour perime). Rend true si cree, false si le nom etait pris.
 */
export const createExclusive = (file, content, { link = linkSync } = {}) => {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    link(tmp, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!NO_LINK.has(error.code)) throw error;
    try {
      writeFileSync(file, content, { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
};

/** Remplacement atomique (rename par-dessus) ; sous Windows, un EPERM passager (fichier ouvert ailleurs) se reessaie. */
const replace = (file, content) => {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (error) {
        if (!(error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY') || i >= 5) throw error;
        pause(15);
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
};

/**
 * L'etat d'un fichier de verrou vu par `pid` : 'free' (absent), 'held' (un autre processus vivant), 'stale' (PID mort,
 * notre propre PID d'un lancement precedent, illisible non vide, ou vide ET vieux), 'young' (vide et recent : en cours
 * d'ecriture, on attend).
 */
const stateOf = (file, pid) => {
  const raw = readRaw(file);
  if (raw === null) return { state: 'free', raw };
  const held = readLock(file);
  if (held) return { state: held.pid !== pid && isAlive(held.pid) ? 'held' : 'stale', raw, held };
  // Vide : peut-etre en cours d'ecriture (repli sans lien) ; perime seulement s'il est vieux. Non vide mais illisible
  // ou sans PID (tronque par un arret brutal) : perime. Le contenu, minuscule, s'ecrit en un seul appel : il n'est
  // jamais vu a moitie ecrit, seulement vide ou entier.
  if (raw.trim() === '') return { state: ageMs(file) > GRACE_MS ? 'stale' : 'young', raw, held: null };
  return { state: 'stale', raw, held: null };
};

/** Un verrou dispute : une reprise ou une ecriture est en cours chez un autre lanceur, sans PID a nommer. */
export const CONTESTED = Object.freeze({ pid: null, contested: true });

/**
 * Prend UN fichier de verrou. Rend `{ ok: true, stale }` ou `{ ok: false, held }`.
 *
 * Creation : `createExclusive` (jamais visible vide). Reprise d'un verrou perime (revues I3 puis N2) : sous un verrou de
 * reprise `<fichier>.break`, lui-meme cree par `createExclusive`, on relit le verrou ; s'il est toujours le meme
 * contenu perime, on le remplace par `rename` (atomique), puis on relit pour verifier que c'est bien notre PID. Un
 * verrou de reprise n'est retire que s'il porte un PID mort (ou s'il est vide ET vieux, GRACE_MS) : jamais sur une
 * lecture vide recente, et jamais celui, tout neuf, d'un autre lanceur. Le retrait passe par un renommage vers un nom unique, puis une
 * relecture : si ce n'etait pas le verrou de reprise perime vu, il est remis en place.
 */
export const acquireFile = (file, mine, pid, { onStale, link } = {}) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const breaker = `${file}.break`;
  const mineBreaker = JSON.stringify({ pid });
  let stale = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (createExclusive(file, mine, { link })) return { ok: true, stale };
    const seen = stateOf(file, pid);
    if (seen.state === 'free') continue; // rendu entre-temps : on retente la creation
    if (seen.state === 'held') return { ok: false, held: seen.held };
    if (seen.state === 'young') {
      pause(10);
      continue;
    }
    onStale?.(); // point d'injection des tests : un autre lanceur agit entre le constat « perime » et la reprise
    if (!createExclusive(breaker, mineBreaker, { link })) {
      const b = stateOf(breaker, pid);
      if (b.state === 'held') return { ok: false, held: { ...CONTESTED, breaker: b.held.pid } };
      if (b.state === 'stale') {
        // Reprise abandonnee par un processus mort : retrait verifie (voir l'en-tete).
        const trash = `${breaker}.${process.pid}.${randomBytes(4).toString('hex')}.old`;
        try {
          renameSync(breaker, trash);
          if (readRaw(trash) !== b.raw) {
            try {
              linkSync(trash, breaker);
            } catch {
              // un autre verrou de reprise est deja en place : le notre etait de trop, on le laisse tomber
            }
          }
        } catch {
          // deja retire par un autre
        } finally {
          rmSync(trash, { force: true });
        }
      } else pause(5);
      continue;
    }
    try {
      if (readRaw(file) !== seen.raw) continue; // repris ou rendu entre-temps : on reexamine
      replace(file, mine);
      if (readLock(file)?.pid !== pid) continue;
      stale = seen.held;
      return { ok: true, stale };
    } finally {
      if (readLock(breaker)?.pid === pid) rmSync(breaker, { force: true });
    }
  }
  return { ok: false, held: CONTESTED };
};

/** Rend un fichier de verrou, seulement s'il est a nous : un verrou repris par un autre ne se supprime pas. */
export const releaseFile = (file, pid) => {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
};

/**
 * Prend le verrou du coffre (les deux fichiers). Rend `{ ok: true, stale }` (`stale` : le verrou perime repris, ou
 * null) ou `{ ok: false, held }` si un autre lanceur vivant le detient. Un refus ne laisse rien derriere lui.
 */
export const acquire = (vault, { pid = process.pid, now = () => new Date().toISOString(), owner } = {}) => {
  const mine = JSON.stringify({ pid, started: now(), ...(owner ? { owner } : {}) }, null, 1);
  const main = acquireFile(lockPath(vault), mine, pid);
  if (!main.ok) return main;
  let legacy;
  try {
    legacy = acquireFile(legacyLockPath(vault), mine, pid);
  } catch (error) {
    releaseFile(lockPath(vault), pid); // erreur disque sur le miroir : on ne garde pas une moitie de verrou
    throw error;
  }
  if (!legacy.ok) {
    releaseFile(lockPath(vault), pid);
    return legacy;
  }
  return { ok: true, stale: main.stale ?? legacy.stale };
};

/** Rend le verrou du coffre (les deux fichiers), chacun seulement s'il est a nous. */
export const release = (vault, pid = process.pid) => {
  releaseFile(lockPath(vault), pid);
  releaseFile(legacyLockPath(vault), pid);
};

/**
 * Qui tient le verrou, pour un message de refus. `owner` est pose par le lanceur : `circuit <nom>` pour un circuit de
 * capture (Plaud, mail), sinon le nom de la commande (`kioku rotate-log`…). Un verrou sans `owner` vient d'une version
 * anterieure du core, ou seul le circuit Plaud et les commandes de la gate le prenaient.
 */
export const holderText = (held) => {
  if (held?.contested) return 'le verrou du coffre est dispute : un autre lanceur le reprend en ce moment';
  const owner = typeof held?.owner === 'string' ? held.owner.replace(/[^\w :.-]/g, '').slice(0, 60) : '';
  const pid = held?.pid ? `, PID ${held.pid}` : '';
  if (owner.startsWith('circuit ')) return `un circuit de capture (${owner.slice(8)}${pid}) tourne`;
  if (owner) return `${owner} tourne (verrou du coffre${pid})`;
  return `un circuit de capture (Plaud ou version anterieure du core${pid}) tourne`;
};

