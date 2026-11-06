/**
 * Ou vivent les secrets du module mail : le TROUSSEAU du systeme par defaut, un fichier 0600 en repli seulement.
 *
 * Pourquoi (revue finale, classe B1) : un jeton dans un fichier, meme hors du coffre et meme ferme par la garde, reste
 * lisible par une session des que la garde se trompe (casse des chemins, interpreteur absent) ; or une session lit du
 * mail non fiable. Au trousseau, plus aucun fichier lisible ne donne acces a la boite.
 *
 * Ce qui y va : `token:<compte>` (le jeton : refresh_token, access_token, expiration) et `client` (client_id et
 * client_secret du client OAuth « Desktop » ; Google ne le tient pas pour un secret fort, mais avec le refresh_token il
 * suffit a lire la boite : il quitte donc le fichier aussi). Service : `kioku-mail`.
 *
 * Sans dependance, par les outils du systeme :
 *   - macOS : `security`. Ecriture par `security -i` (commandes lues sur l'entree standard) et `-X <hex>` : le secret
 *     ne passe JAMAIS en argument d'un processus (visible par `ps`), ni en clair dans la commande (hexadecimal, sans
 *     guillemets a echapper). Lecture : `find-generic-password -w`, qui l'ecrit sur la sortie standard.
 *   - Linux : `secret-tool` (libsecret, service de secrets D-Bus). Le secret passe sur l'entree standard de `store`.
 *   - Windows : pas de trousseau sans dependance assez sur ici. `cmdkey` ecrit dans le Gestionnaire d'identification
 *     mais ne relit pas le secret ; CredRead exige PowerShell + Add-Type, non teste sur cette plateforme. Repli fichier,
 *     dit a chaque lancement.
 * Repli fichier (`secretStore: "file"`, ou aucun trousseau disponible) : `<config>/kioku/mail/`, fichiers 0600,
 * dossier 0700, avec un avertissement a chaque lancement et dans `kioku doctor`.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ACCOUNT_ID, clientPath, configDir, tokenPath } from './paths.mjs';

export const SERVICE = 'kioku-mail';
export const STORE_MODES = ['keychain', 'file'];

export class SecretStoreError extends Error {}

const keyOk = (key) => key === 'client' || (key.startsWith('token:') && ACCOUNT_ID.test(key.slice(6)));
const checkKey = (key) => {
  if (!keyOk(key)) throw new SecretStoreError(`cle de secret invalide : ${key}`);
  return key;
};

const run = (cmd, args, { env, input } = {}) => spawnSync(cmd, args, { env, input, encoding: 'utf8', timeout: 30_000 });
const tail = (r) => String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0].slice(0, 200);

// --- macOS ---

const macos = (env) => {
  const probe = run('security', ['help'], { env });
  if (probe.error) return null; // `security` introuvable
  return {
    kind: 'trousseau macOS',
    get(key) {
      const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', checkKey(key), '-w'], { env });
      if (r.status === 0) return r.stdout.replace(/\n$/, '');
      if (r.status === 44 || /could not be found/i.test(r.stderr ?? '')) return null;
      throw new SecretStoreError(`trousseau macOS inaccessible (${tail(r) || `code ${r.status}`}) : deverrouille la session ou le trousseau, puis relance`);
    },
    set(key, value) {
      const hex = Buffer.from(String(value), 'utf8').toString('hex');
      const r = run('security', ['-i'], { env, input: `add-generic-password -U -s ${SERVICE} -a ${checkKey(key)} -X ${hex}\n` });
      // En mode -i, `security` peut sortir en 0 meme si la commande a echoue : seule la relecture fait foi.
      if (r.error || r.status !== 0 || this.get(key) !== String(value)) {
        throw new SecretStoreError(`ecriture au trousseau macOS refusee (${tail(r) || 'relecture differente'}) : deverrouille le trousseau, puis relance`);
      }
    },
    del(key) {
      const r = run('security', ['delete-generic-password', '-s', SERVICE, '-a', checkKey(key)], { env });
      if (r.status !== 0 && r.status !== 44 && !/could not be found/i.test(r.stderr ?? '')) throw new SecretStoreError(`suppression au trousseau macOS refusee (${tail(r)})`);
    },
  };
};

// --- Linux ---

const linux = (env) => {
  const probe = run('secret-tool', ['lookup', 'service', `${SERVICE}-probe`, 'account', 'probe'], { env });
  if (probe.error) return null; // `secret-tool` introuvable
  // Sans service de secrets (pas de D-Bus, pas de gnome-keyring / KeePassXC) : une erreur sur la sortie d'erreur.
  if (probe.status !== 0 && (probe.stderr ?? '').trim()) return null;
  return {
    kind: 'trousseau (secret-tool)',
    get(key) {
      const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', checkKey(key)], { env });
      if (r.status === 0) return r.stdout.replace(/\n$/, '');
      if (!(r.stderr ?? '').trim()) return null; // introuvable : code 1, rien sur la sortie d'erreur
      throw new SecretStoreError(`trousseau inaccessible (${tail(r)}) : deverrouille-le, puis relance`);
    },
    set(key, value) {
      const r = run('secret-tool', ['store', `--label=Kioku mail ${checkKey(key)}`, 'service', SERVICE, 'account', key], { env, input: String(value) });
      if (r.error || r.status !== 0 || this.get(key) !== String(value)) throw new SecretStoreError(`ecriture au trousseau refusee (${tail(r) || 'relecture differente'}) : deverrouille-le, puis relance`);
    },
    del(key) {
      run('secret-tool', ['clear', 'service', SERVICE, 'account', checkKey(key)], { env });
    },
  };
};

// --- Repli fichier ---

const fileFor = (key, dir) => (key === 'client' ? clientPath(dir) : tokenPath(key.slice(6), dir));

/** Ecriture 0600 par fichier temporaire puis renommage ; dossier 0700, resserre s'il existait deja (hors Windows). */
export const writeSecretFile = (file, text) => {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

export const fileStore = (dir = configDir()) => ({
  kind: 'fichier',
  dir,
  get(key) {
    const file = fileFor(checkKey(key), dir);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  },
  set(key, value) {
    writeSecretFile(fileFor(checkKey(key), dir), String(value));
  },
  del(key) {
    rmSync(fileFor(checkKey(key), dir), { force: true });
  },
});

/**
 * Le magasin de secrets. `mode` : `keychain` (defaut : le trousseau, repli fichier s'il n'y en a pas) ou `file`.
 * Rend { kind, get, set, del, file: bool, fallback: raison|null, dir }.
 */
export const secretStore = ({ mode = 'keychain', dir = configDir(), env = process.env, platform = process.platform } = {}) => {
  if (!STORE_MODES.includes(mode)) throw new SecretStoreError(`secretStore inconnu : ${mode} (keychain ou file)`);
  if (mode === 'file') return { ...fileStore(dir), file: true, fallback: 'secretStore: "file" dans la configuration' };
  const keychain = platform === 'darwin' ? macos(env) : platform === 'linux' ? linux(env) : null;
  if (keychain) return { ...keychain, file: false, fallback: null, dir };
  const why =
    platform === 'darwin'
      ? 'commande security introuvable'
      : platform === 'linux'
        ? 'secret-tool introuvable, ou aucun service de secrets (gnome-keyring, KeePassXC…) disponible'
        : platform === 'win32'
          ? 'pas de trousseau Windows sans dependance dans cette version'
          : `plateforme ${platform} sans trousseau connu`;
  return { ...fileStore(dir), file: true, fallback: why };
};

/** L'avertissement a afficher quand les secrets sont en fichier ; null au trousseau. */
export const fileWarning = (store) =>
  store.file ? `Attention : secrets du module mail en FICHIER (${store.fallback}), dans ${store.dir}. Ils sont lisibles par tout processus de ton compte ; un trousseau les protege mieux.` : null;
