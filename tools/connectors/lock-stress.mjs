#!/usr/bin/env node
/**
 * Banc de stress du verrou commun (revue N2) : N lanceurs sur un verrou PERIME, au meme instant, et le gagnant garde
 * le verrou jusqu'a ce que tous aient tente (un lanceur tardif ne peut donc pas le prendre legitimement apres coup).
 * Chaque manche doit donner exactement un detenteur.
 *
 *   node tools/connectors/lock-stress.mjs [--rounds 1000] [--workers 16] [--fresh]
 *
 * Les lanceurs sont des processus persistants (un par lanceur, pour toutes les manches) : chaque manche ne coute que la
 * synchronisation, pas le demarrage de N processus. Synchronisation par fichiers dans un dossier temporaire.
 * Rend { rounds, doubles, none } ; code de sortie 1 si une manche a eu zero ou plusieurs detenteurs.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isAlive, legacyLockPath, lockPath } from './lock.mjs';

const LOCK = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lock.mjs')).href;

const deadPid = () => {
  for (let pid = 4_194_300; pid > 4_000_000; pid--) if (!isAlive(pid)) return pid;
  throw new Error('aucun PID libre');
};

// Un lanceur : pour chaque manche r, attend go-r, tente, ecrit res-r-i (OK/NO), et s'il tient le verrou, le garde
// jusqu'a fin-r puis le rend. S'arrete sur stop.
const worker = (vault, dir, i) => `
import { existsSync, writeFileSync } from 'node:fs';
const L = await import(${JSON.stringify(LOCK)});
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const f = (n) => ${JSON.stringify(dir)} + '/' + n;
writeFileSync(f('ready-${i}'), '');
for (let r = 0; ; r++) {
  while (!existsSync(f('go-' + r))) { if (existsSync(f('stop'))) process.exit(0); nap(); }
  // Gigue de 0 a 3 ms : sans elle, des lanceurs trop synchronises lisent tous avant que quiconque ecrive, et la
  // fenetre de course (lire un verrou cree mais pas encore ecrit) n'est jamais touchee.
  const until = performance.now() + Math.random() * 3;
  while (performance.now() < until) {}
  const res = L.acquire(${JSON.stringify(vault)});
  writeFileSync(f('res-' + r + '-${i}'), res.ok ? 'OK' : 'NO');
  if (res.ok) { while (!existsSync(f('fin-' + r))) nap(); L.release(${JSON.stringify(vault)}); writeFileSync(f('rel-' + r), ''); }
}
`;

const waitFor = async (test, timeoutMs = 30_000) => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error('banc : delai depasse');
    await new Promise((r) => setTimeout(r, 2));
  }
};

// Mode « frais » : de nouveaux processus a chaque manche (comme le banc de la contre-revue), plus lent mais avec la
// variabilite d'un demarrage reel ; chaque processus ne joue qu'une manche.
const freshWorker = (vault, dir, i, r) => `
import { existsSync, writeFileSync } from 'node:fs';
const L = await import(${JSON.stringify(LOCK)});
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const f = (n) => ${JSON.stringify(dir)} + '/' + n;
writeFileSync(f('ready-${r}-${i}'), '');
while (!existsSync(f('go-${r}'))) nap();
const res = L.acquire(${JSON.stringify(vault)});
writeFileSync(f('res-${r}-${i}'), res.ok ? 'OK' : 'NO');
if (res.ok) { while (!existsSync(f('fin-${r}'))) nap(); L.release(${JSON.stringify(vault)}); writeFileSync(f('rel-${r}'), ''); }
`;

export const stressFresh = async ({ rounds = 50, workers = 16 } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kioku-lock-stress-'));
  const vault = path.join(root, 'coffre');
  const dir = path.join(root, 'sync');
  mkdirSync(vault);
  mkdirSync(dir);
  const result = { rounds, workers, doubles: 0, none: 0, failures: [] };
  try {
    for (let r = 0; r < rounds; r++) {
      const mort = JSON.stringify({ pid: deadPid(), started: 'vieux' });
      for (const file of [lockPath(vault), legacyLockPath(vault)]) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, mort);
      }
      const kids = Array.from({ length: workers }, (_, i) => spawn(process.execPath, ['--input-type=module', '-e', freshWorker(vault, dir, i, r)], { stdio: 'ignore' }));
      await waitFor(() => Array.from({ length: workers }, (_, i) => path.join(dir, `ready-${r}-${i}`)).every(existsSync));
      writeFileSync(path.join(dir, `go-${r}`), '');
      const res = Array.from({ length: workers }, (_, i) => path.join(dir, `res-${r}-${i}`));
      await waitFor(() => res.every(existsSync));
      const ok = res.filter((f) => readFileSync(f, 'utf8') === 'OK').length;
      if (ok > 1) result.doubles++;
      if (ok === 0) result.none++;
      if (ok !== 1) result.failures.push({ round: r, ok });
      writeFileSync(path.join(dir, `fin-${r}`), '');
      await Promise.all(kids.map((c) => new Promise((done) => (c.exitCode !== null ? done() : c.on('exit', done)))));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return result;
};

export const stress = async ({ rounds = 100, workers = 16 } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kioku-lock-stress-'));
  const vault = path.join(root, 'coffre');
  const dir = path.join(root, 'sync');
  mkdirSync(vault);
  mkdirSync(dir);
  const children = Array.from({ length: workers }, (_, i) => spawn(process.execPath, ['--input-type=module', '-e', worker(vault, dir, i)], { stdio: 'ignore' }));
  const result = { rounds, workers, doubles: 0, none: 0, failures: [] };
  try {
    await waitFor(() => Array.from({ length: workers }, (_, i) => path.join(dir, `ready-${i}`)).every(existsSync));
    for (let r = 0; r < rounds; r++) {
      const mort = JSON.stringify({ pid: deadPid(), started: 'vieux' });
      for (const file of [lockPath(vault), legacyLockPath(vault)]) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, mort);
      }
      writeFileSync(path.join(dir, `go-${r}`), '');
      const res = Array.from({ length: workers }, (_, i) => path.join(dir, `res-${r}-${i}`));
      await waitFor(() => res.every(existsSync));
      const ok = res.filter((f) => readFileSync(f, 'utf8') === 'OK').length;
      if (ok > 1) result.doubles++;
      if (ok === 0) result.none++;
      if (ok !== 1) result.failures.push({ round: r, ok });
      writeFileSync(path.join(dir, `fin-${r}`), '');
      if (ok >= 1) await waitFor(() => existsSync(path.join(dir, `rel-${r}`)));
    }
  } finally {
    writeFileSync(path.join(dir, 'stop'), '');
    await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.on('exit', r)))));
    rmSync(root, { recursive: true, force: true });
  }
  return result;
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
  const t = Date.now();
  const run = argv.includes('--fresh') ? stressFresh : stress;
  const r = await run({ rounds: opt('--rounds', 1000), workers: opt('--workers', 16) });
  console.log(`${r.rounds} manches, ${r.workers} lanceurs : ${r.doubles} double(s) detenteur(s), ${r.none} sans detenteur, ${Math.round((Date.now() - t) / 1000)} s`);
  if (r.failures.length) console.log(JSON.stringify(r.failures.slice(0, 20)));
  process.exit(r.failures.length ? 1 : 0);
}
