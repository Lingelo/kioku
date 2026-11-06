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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Prend UN fichier de verrou. Rend `{ ok: true, stale }` ou `{ ok: false, held }`.
 *
 * Creation exclusive (`wx`). Si le fichier existe et que son processus vit : refus. S'il est perime (processus mort,
 * fichier illisible, ou notre propre PID d'un lancement precedent), la REPRISE doit etre atomique : sans precaution,
 * deux lanceurs qui le voient perime en meme temps le suppriment chacun, et le second supprime le verrou tout neuf du
 * premier (revue I3). La reprise passe donc par un verrou de reprise `<fichier>.break`, lui-meme pris en `wx` : un seul
 * lanceur reprend a la fois. Sous lui, on relit le verrou : s'il n'a pas change depuis qu'on l'a juge perime, on le
 * remplace (suppression puis creation exclusive, sous le verrou de reprise) ; sinon un autre l'a repris entre-temps,
 * et on recommence l'examen. Un verrou de reprise dont le processus est mort (arret pendant les quelques
 * microsecondes de la reprise) est retire au tour suivant.
 */
export const acquireFile = (file, mine, pid, { onStale } = {}) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const breaker = `${file}.break`;
  let stale = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      return { ok: true, stale };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const seen = readRaw(file);
    const held = readLock(file);
    if (held && held.pid !== pid && isAlive(held.pid)) return { ok: false, held };
    onStale?.(); // point d'injection des tests : un autre lanceur agit entre le constat « perime » et la reprise
    try {
      writeFileSync(breaker, JSON.stringify({ pid }), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const b = readLock(breaker);
      if (b && b.pid !== pid && isAlive(b.pid)) return { ok: false, held: b }; // un autre lanceur reprend en ce moment
      rmSync(breaker, { force: true }); // reprise abandonnee par un processus mort
      continue;
    }
    try {
      if (readRaw(file) !== seen) continue; // repris ou rendu entre-temps : on reexamine
      stale = held;
      rmSync(file, { force: true });
      try {
        writeFileSync(file, mine, { flag: 'wx' });
        return { ok: true, stale };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      rmSync(breaker, { force: true });
    }
  }
  return { ok: false, held: readLock(file) ?? { pid: null } };
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
  const owner = typeof held?.owner === 'string' ? held.owner.replace(/[^\w :.-]/g, '').slice(0, 60) : '';
  const pid = held?.pid ? `, PID ${held.pid}` : '';
  if (owner.startsWith('circuit ')) return `un circuit de capture (${owner.slice(8)}${pid}) tourne`;
  if (owner) return `${owner} tourne (verrou du coffre${pid})`;
  return `un circuit de capture (Plaud ou version anterieure du core${pid}) tourne`;
};

