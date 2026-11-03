/**
 * Tests du CLI kioku (plan core/data, U9) : `node --test tools/kioku.test.mjs`
 * Coffres factices dans des dossiers temporaires, domaines fictifs. La garde testee est celle du depot (la vraie),
 * branchee par les settings que init ecrit ; aucun fichier du coffre reel n'est lu ni ecrit.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { EXIT } from './kioku.mjs';
import { HOOKS_DIR } from './test-vault.mjs';

const KIOKU = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kioku.mjs');
const GUARD = path.join(HOOKS_DIR, 'guard.mjs');
const RAW = 'r' + 'aw';
const WIKI = 'wi' + 'ki';
const RULES = 'dom' + 'ains';

let root;
let vault;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kioku-test-')));
  vault = path.join(root, 'coffre');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Hors session Claude : on retire ce que la session de test aurait herite.
// HOME factice : doctor lit aussi ~/.claude/settings.json (un plugin s'active souvent la) ; les tests ne dependent
// jamais des settings de la machine qui les lance.
const kioku = (args, extraEnv = {}) => {
  const env = { ...process.env, HOME: path.join(root, 'home'), ...extraEnv };
  if (!('CLAUDECODE' in extraEnv)) delete env.CLAUDECODE;
  if (!('VAULT_MODE' in extraEnv)) delete env.VAULT_MODE;
  delete env.VAULT_DOMAIN;
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [KIOKU, ...args], { encoding: 'utf8', env });
};

/** Empreinte de chaque fichier sous les dossiers donnes : pour prouver qu'add-domain n'y touche pas. */
const fingerprint = (dirs) => {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    if (!statSync(dir).isDirectory()) {
      out[path.relative(vault, dir)] = createHash('sha256').update(readFileSync(dir)).digest('hex');
      return;
    }
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(vault, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  dirs.forEach((d) => walk(path.join(vault, d)));
  return out;
};

describe('init', () => {
  test('dossier vide, presets pro et perso : configuration, squelette, regles, garde branchee, doctor vert', () => {
    const r = kioku(['init', vault, '--domains', 'pro,perso', '--org', 'pro']);
    assert.equal(r.status, EXIT.ok, r.stdout);
    assert.match(r.stdout, /cloisonnement prouve/);
    const cfg = JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'));
    assert.deepEqual(cfg.domains.map((d) => d.id), ['pro', 'perso']);
    assert.equal(cfg.domains[0].extensions.org.registry, 'orgs.json');
    for (const d of ['pro', 'perso']) {
      assert.ok(existsSync(path.join(vault, WIKI, d, 'concepts', '.gitkeep')), d);
      assert.match(readFileSync(path.join(vault, RULES, d, 'rules.md'), 'utf8'), /^## Relecture$/m);
    }
    assert.ok(existsSync(path.join(vault, 'orgs.json')));
    const settings = JSON.parse(readFileSync(path.join(vault, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.enabledPlugins, { 'kioku@dojo': true }, 'la garde est le plugin de la marketplace dojo');
  });

  test('--guard-hook : repli de developpement, le hook vise la garde de ce core, schema aux noms nus', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a,b', '--guard-hook']).status, EXIT.ok);
    const settings = readFileSync(path.join(vault, '.claude', 'settings.json'), 'utf8');
    assert.ok(settings.includes(GUARD), 'le hook vise la garde du core');
    assert.doesNotMatch(settings, /kioku-pin/);
    assert.doesNotMatch(readFileSync(path.join(vault, '.kioku', 'schema.md'), 'utf8'), /kioku:/);
  });

  // Le schema suit la garde que init declare (plugin : noms prefixes ; --guard-hook : noms nus), pas KIOKU_PLUGIN.
  test('schema commun : pose dans .kioku/, importe par le CLAUDE.md, noms nus sans plugin et prefixes avec', () => {
    kioku(['init', vault, '--domains', 'a,b', '--guard-hook'], { KIOKU_PLUGIN: 'kioku' });
    const schema = readFileSync(path.join(vault, '.kioku', 'schema.md'), 'utf8');
    assert.match(schema, /^## 7\. La gate/m);
    assert.doesNotMatch(schema, /kioku:/, 'sans plugin : /ingest, reviewer');
    assert.match(readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), /^@\.kioku\/schema\.md$/m);
    const other = path.join(root, 'autre');
    kioku(['init', other, '--domains', 'a,b'], { KIOKU_PLUGIN: '' });
    assert.match(readFileSync(path.join(other, '.kioku', 'schema.md'), 'utf8'), /\/kioku:ingest/);
  });

  test('doctor : avec le plugin active, le schema attendu est le schema prefixe', () => {
    kioku(['init', vault, '--domains', 'a,b'], { KIOKU_PLUGIN: 'kioku' });
    writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kioku@x': true } }));
    const r = kioku(['doctor', '--vault', vault]);
    assert.doesNotMatch(r.stdout, /schema\.md differe/, r.stdout);
  });

  test('doctor : schema absent = a corriger ; schema modifie = signale, sans echec', () => {
    kioku(['init', vault, '--domains', 'a,b'], { KIOKU_PLUGIN: '' });
    const schema = path.join(vault, '.kioku', 'schema.md');
    writeFileSync(schema, `${readFileSync(schema, 'utf8')}\nretouche\n`);
    const changed = kioku(['doctor', '--vault', vault], { KIOKU_PLUGIN: '' });
    assert.equal(changed.status, EXIT.ok, changed.stdout);
    assert.match(changed.stdout, /schema\.md differe/);
    rmSync(schema);
    const gone = kioku(['doctor', '--vault', vault], { KIOKU_PLUGIN: '' });
    assert.equal(gone.status, EXIT.precondition, gone.stdout);
    assert.match(gone.stdout, /schema\.md absent/);
  });

  test('les presets ne portent que le nom du domaine, aucun gabarit oublie', () => {
    kioku(['init', vault, '--domains', 'travail']);
    const text = readFileSync(path.join(vault, RULES, 'travail', 'rules.md'), 'utf8');
    assert.match(text, /`travail`/);
    assert.doesNotMatch(text, /\{\{/);
  });

  test('dossier qui ne contient que .git (depot vide clone ou git init) : accepte, .git intact', () => {
    mkdirSync(path.join(vault, '.git'), { recursive: true });
    writeFileSync(path.join(vault, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.ok);
    assert.equal(readFileSync(path.join(vault, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  });

  test('dossier avec .claude deja present : refus, rien n est ecrit', () => {
    mkdirSync(path.join(vault, '.claude'), { recursive: true });
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.precondition);
    assert.deepEqual(readdirSync(vault), ['.claude']);
  });

  test('dossier non vide : refus, rien n est ecrit', () => {
    mkdirSync(vault);
    writeFileSync(path.join(vault, 'deja.txt'), 'x');
    const r = kioku(['init', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.deepEqual(readdirSync(vault), ['deja.txt']);
  });

  test('noms invalides, en double, reserves ; --org hors des domaines : refus sans rien ecrire', () => {
    for (const domains of ['Pro,perso', 'a,a', 'heritage', 'a_b']) {
      const r = kioku(['init', vault, '--domains', domains]);
      assert.equal(r.status, EXIT.precondition, domains);
      assert.ok(!existsSync(vault), domains);
    }
    assert.equal(kioku(['init', vault, '--domains', 'a,b', '--org', 'c']).status, EXIT.precondition);
  });

  test('Covers AE7 : sans --plaud, aucun reglage ni fichier Plaud', () => {
    kioku(['init', vault, '--domains', 'a,b']);
    const cfg = JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'));
    assert.deepEqual(cfg.modules, { dashboard: {} });
    assert.ok(!existsSync(path.join(vault, 'tools')));
    assert.doesNotMatch(readFileSync(path.join(vault, '.gitignore'), 'utf8'), /plaud/);
  });

  const pkg = (dir = vault) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

  test('chantier 2 : package.json, scripts par domaine et communs, plaud conditionnel', () => {
    assert.equal(kioku(['init', vault, '--domains', 'travail,perso', '--plaud']).status, EXIT.ok);
    const { scripts, private: priv } = pkg();
    assert.equal(priv, true);
    for (const d of ['travail', 'perso']) {
      for (const k of [d, `ingest:${d}`, `lint:${d}`, `audit:${d}`, `dashboard:${d}`, `dashboard:serve:${d}`]) assert.ok(scripts[k], k);
    }
    for (const k of ['vault', 'triage', 'setup', 'doctor', 'undecided', 'dashboard', 'dashboard:all', 'plaud:sync', 'plaud:dry-run', 'plaud:pending', 'plaud:drop']) assert.ok(scripts[k], k);
    assert.equal(scripts.travail, 'kioku session travail');
    assert.equal(scripts['dashboard:serve:perso'], 'kioku dashboard perso --serve');
    assert.equal(scripts.dashboard, 'kioku dashboard travail', 'dashboard = premier domaine');
    assert.ok(!JSON.stringify(scripts).includes('KIOKU_HOME'), 'aucun repli sur un clone');
    const other = path.join(root, 'sans-plaud');
    kioku(['init', other, '--domains', 'a']);
    assert.ok(!Object.keys(pkg(other).scripts).some((k) => k.startsWith('plaud')));
  });

  test('chantier 2 : config (module dashboard, default_session), index et log, gitignore, gitattributes', () => {
    assert.equal(kioku(['init', vault, '--domains', 'travail,perso']).status, EXIT.ok);
    const cfg = JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'));
    assert.deepEqual(cfg.modules, { dashboard: {} });
    assert.deepEqual(cfg.default_session, { mode: 'query', domain: 'travail' });
    for (const d of ['travail', 'perso']) {
      assert.match(readFileSync(path.join(vault, WIKI, d, 'index.md'), 'utf8'), /^# Index/m);
      assert.match(readFileSync(path.join(vault, WIKI, d, 'log.md'), 'utf8'), /^## \[\d{4}-\d\d-\d\d \d\d:\d\d\] schema \| creation du domaine$/m);
    }
    const gi = readFileSync(path.join(vault, '.gitignore'), 'utf8');
    assert.match(gi, /^tools\/dashboard\/dashboard-\*\.html$/m);
    assert.match(gi, /^# >>> kioku/m);
    assert.match(gi, /^# <<< kioku$/m);
    assert.equal(readFileSync(path.join(vault, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  });

  test('le coffre active le plugin kioku@dojo, sans version, marketplace ni hook ; format declare', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a,b']).status, EXIT.ok);
    const s = JSON.parse(readFileSync(path.join(vault, '.claude', 'settings.json'), 'utf8'));
    assert.equal(s.hooks, undefined);
    assert.deepEqual(s, { enabledPlugins: { 'kioku@dojo': true } }, 'le coffre declare seulement le plugin');
    assert.equal(JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8')).format, 1);
    assert.match(readFileSync(path.join(vault, '.kioku', 'schema.md'), 'utf8'), /\/kioku:ingest/, 'schema prefixe : le plugin porte les skills');
  });

  test('fin d init = etapes suivantes', () => {
    const r = kioku(['init', vault, '--domains', 'travail,perso', '--org', 'travail']);
    for (const step of [/orgs\.json/, /CLAUDE\.md/, /claude plugin marketplace add <owner>\/dojo/, /claude plugin install kioku@dojo --scope user/, /kioku doctor --live/, /npm run travail/]) assert.match(r.stdout, step);
  });

  test('doctor : coffre au format plus recent que le core : refus nomme, avant toute sonde', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.ok);
    const file = path.join(vault, 'kioku.config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), format: 99 }));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /exige le format 99/);
    assert.doesNotMatch(r.stdout, /cloisonnement prouve/);
  });

  test('en session Claude hors setup : refus ; en setup : permis', () => {
    assert.equal(kioku(['init', vault], { CLAUDECODE: '1', VAULT_MODE: 'query' }).status, EXIT.precondition);
    assert.ok(!existsSync(vault));
    assert.equal(kioku(['init', vault, '--domains', 'a,b'], { CLAUDECODE: '1', VAULT_MODE: 'setup' }).status, EXIT.ok);
  });

  // /kioku:setup create : une session ouverte dans un dossier vide n'a pas de VAULT_MODE (aucun coffre pour le poser),
  // et la garde ne s'y applique pas. init y est permis, et seulement la : rien a proteger, rien a ecraser.
  test('session Claude sans mode, cible hors coffre (dossier vide ou .git seul) : init permis', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a,b'], { CLAUDECODE: '1' }).status, EXIT.ok);
    const withGit = path.join(root, 'avec-git');
    mkdirSync(path.join(withGit, '.git'), { recursive: true });
    assert.equal(kioku(['init', withGit, '--domains', 'a'], { CLAUDECODE: '1' }).status, EXIT.ok);
  });

  test('session Claude sans mode, cible deja coffre ou dans un coffre : refus', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a'], { CLAUDECODE: '1' }).status, EXIT.ok);
    const sub = path.join(vault, 'sous-coffre');
    const r = kioku(['init', sub, '--domains', 'b'], { CLAUDECODE: '1' });
    assert.equal(r.status, EXIT.precondition, 'un dossier dans un coffre n est pas hors coffre');
    assert.ok(!existsSync(path.join(sub, 'kioku.config.json')));
  });

  test('session Claude sans mode : add-domain et upgrade --write restent refuses (ils visent un coffre)', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.ok);
    assert.equal(kioku(['add-domain', 'b', '--vault', vault], { CLAUDECODE: '1' }).status, EXIT.precondition);
    assert.equal(kioku(['upgrade', '--write', '--vault', vault], { CLAUDECODE: '1' }).status, EXIT.precondition);
  });
});

describe('add-domain : package.json (parties gerees)', () => {
  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b']).status, EXIT.ok));
  const file = () => path.join(vault, 'package.json');

  test('ajoute les scripts geres du domaine, garde les scripts maison, ne remplace pas une cle maison', () => {
    const before = JSON.parse(readFileSync(file(), 'utf8'));
    before.scripts.digest = 'echo maison';
    before.scripts['lint:c'] = 'echo deja la';
    writeFileSync(file(), `${JSON.stringify(before, null, 2)}\n`);
    const r = kioku(['add-domain', 'c', '--vault', vault]);
    assert.equal(r.status, EXIT.ok, r.stdout);
    const { scripts } = JSON.parse(readFileSync(file(), 'utf8'));
    assert.equal(scripts.digest, 'echo maison');
    assert.equal(scripts['lint:c'], 'echo deja la');
    assert.match(r.stdout, /lint:c.*script maison/);
    for (const k of ['c', 'ingest:c', 'audit:c', 'dashboard:c', 'dashboard:serve:c']) assert.ok(scripts[k], k);
    assert.equal(scripts.a, before.scripts.a);
  });

  test('un script gere (prefixe kioku) a une ancienne forme est reecrit', () => {
    const before = JSON.parse(readFileSync(file(), 'utf8'));
    before.scripts['ingest:a'] = 'kioku session a --vieille-option';
    writeFileSync(file(), `${JSON.stringify(before, null, 2)}\n`);
    kioku(['add-domain', 'c', '--vault', vault]);
    assert.equal(JSON.parse(readFileSync(file(), 'utf8')).scripts['ingest:a'], 'kioku session a --mode ingest');
  });

  test('sans package.json : le cree ; illisible : add-domain reussit, le signale, ne le reecrit pas', () => {
    rmSync(file());
    assert.equal(kioku(['add-domain', 'c', '--vault', vault]).status, EXIT.ok);
    assert.ok(JSON.parse(readFileSync(file(), 'utf8')).scripts.c);
    writeFileSync(file(), '{ casse');
    const r = kioku(['add-domain', 'd', '--vault', vault]);
    assert.match(r.stdout, /package\.json .*illisible/);
    assert.equal(readFileSync(file(), 'utf8'), '{ casse');
  });

  test('wiki/<D>/index.md et log.md crees', () => {
    kioku(['add-domain', 'c', '--vault', vault]);
    assert.ok(existsSync(path.join(vault, WIKI, 'c', 'index.md')));
    assert.ok(existsSync(path.join(vault, WIKI, 'c', 'log.md')));
  });
});

describe('upgrade', () => {
  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b']).status, EXIT.ok));

  test('coffre tout juste cree : deja a la forme courante (init et upgrade produisent la meme chose)', () => {
    const r = kioku(['upgrade', '--vault', vault]);
    assert.equal(r.status, EXIT.ok, r.stdout);
    assert.match(r.stdout, /deja a la forme courante/);
  });

  test('simulation par defaut : diff montre, rien n est ecrit ; --write applique, puis idempotent', () => {
    const pkg = path.join(vault, 'package.json');
    const data = JSON.parse(readFileSync(pkg, 'utf8'));
    data.scripts = { a: 'node ~/mon-clone/tools/vault.mjs --domain a', 'ingest:a': 'kioku vieux', digest: 'echo maison' };
    writeFileSync(pkg, `${JSON.stringify(data, null, 2)}\n`);
    rmSync(path.join(vault, '.gitattributes'));
    rmSync(path.join(vault, WIKI, 'b', 'index.md'));
    writeFileSync(path.join(vault, '.gitignore'), 'node_modules/\n');
    const snapshot = readFileSync(pkg, 'utf8');

    const dry = kioku(['upgrade', '--vault', vault]);
    assert.equal(dry.status, EXIT.ok, dry.stdout);
    assert.match(dry.stdout, /simulation/);
    assert.match(dry.stdout, /=== package\.json/);
    assert.match(dry.stdout, /\+.*"ingest:a": "kioku session a --mode ingest"/);
    assert.match(dry.stdout, /=== \.gitattributes \(cree\)/);
    assert.match(dry.stdout, /a.*script maison/, 'la cle a, maison (sans prefixe), est signalee');
    assert.equal(readFileSync(pkg, 'utf8'), snapshot, 'simulation : rien d ecrit');
    assert.ok(!existsSync(path.join(vault, '.gitattributes')));

    const w = kioku(['upgrade', '--write', '--vault', vault]);
    assert.equal(w.status, EXIT.ok, w.stdout);
    const after = JSON.parse(readFileSync(pkg, 'utf8')).scripts;
    assert.equal(after.digest, 'echo maison');
    assert.equal(after.a, data.scripts.a);
    assert.equal(after['ingest:a'], 'kioku session a --mode ingest');
    assert.ok(after['dashboard:serve:b']);
    assert.match(readFileSync(path.join(vault, '.gitignore'), 'utf8'), /^node_modules\/\n\n# >>> kioku/);
    assert.ok(existsSync(path.join(vault, WIKI, 'b', 'index.md')));
    assert.match(kioku(['upgrade', '--vault', vault]).stdout, /deja a la forme courante/);
  });

  test('ne touche ni CLAUDE.md, ni regles, ni donnees ; config en ajout seul ; settings : migre l ancien catalogue epingle', () => {
    const cfgFile = path.join(vault, 'kioku.config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    cfg.default_session = { mode: 'setup' };
    delete cfg.modules;
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const settingsFile = path.join(vault, '.claude', 'settings.json');
    const st = JSON.parse(readFileSync(settingsFile, 'utf8'));
    st.permissions = { allow: ['Bash(ls)'] };
    // Un coffre de l'ancienne forme : catalogue epingle par coffre, au lieu de la marketplace.
    st.extraKnownMarketplaces = { 'kioku-pin': { source: { source: 'settings', name: 'kioku-pin', plugins: [{ name: 'kioku', source: { source: 'github', repo: 'o/r', sha: '0'.repeat(40) } }] } } };
    st.enabledPlugins = { 'kioku@kioku-pin': true };
    writeFileSync(settingsFile, JSON.stringify(st));
    writeFileSync(path.join(vault, 'CLAUDE.md'), 'maison\n');
    writeFileSync(path.join(vault, WIKI, 'a', 'concepts', 'x.md'), 'donnee\n');
    const guarded = fingerprint([WIKI, RULES, 'CLAUDE.md']);

    assert.equal(kioku(['upgrade', '--write', '--vault', vault]).status, EXIT.ok);
    assert.deepEqual(fingerprint([WIKI, RULES, 'CLAUDE.md']), guarded);
    const out = JSON.parse(readFileSync(cfgFile, 'utf8'));
    assert.deepEqual(out.default_session, { mode: 'setup' }, 'valeur posee : jamais ecrasee');
    assert.deepEqual(out.modules, { dashboard: {} });
    const s2 = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(s2.permissions, { allow: ['Bash(ls)'] });
    assert.equal(s2.extraKnownMarketplaces, undefined);
    assert.deepEqual(s2.enabledPlugins, { 'kioku@dojo': true });
    assert.doesNotMatch(JSON.stringify(s2), /kioku-pin|sha/);
  });

  test('hook de garde du projet : plugin non active (double garde), signale', () => {
    const other = path.join(root, 'hook');
    kioku(['init', other, '--domains', 'a', '--guard-hook']);
    const r = kioku(['upgrade', '--write', '--vault', other]);
    assert.match(r.stdout, /hook de garde du projet present/);
    assert.doesNotMatch(readFileSync(path.join(other, '.claude', 'settings.json'), 'utf8'), /kioku@dojo|enabledPlugins/);
  });

  test('upgrade --write en session hors setup : refus ; simulation : permise', () => {
    assert.equal(kioku(['upgrade', '--write', '--vault', vault], { CLAUDECODE: '1', VAULT_MODE: 'query' }).status, EXIT.precondition);
    assert.equal(kioku(['upgrade', '--vault', vault], { CLAUDECODE: '1', VAULT_MODE: 'query' }).status, EXIT.ok);
  });
});

describe('add-domain', () => {
  beforeEach(() => {
    const r = kioku(['init', vault, '--domains', 'pro,perso', '--org', 'pro', '--guard-hook']);
    assert.equal(r.status, EXIT.ok, r.stdout);
    // Du contenu dans les domaines existants, pour prouver qu'add-domain n'y touche pas.
    writeFileSync(path.join(vault, WIKI, 'pro', 'concepts', 'x.md'), '---\ntype: concept\ntitle: X\n---\n');
    writeFileSync(path.join(vault, RAW, 'perso', 'note.md'), '# note inventee\n');
  });

  test('Covers AE1 : asso cree, rien de pro ni de perso ne change, doctor prouve les 6 paires', () => {
    const before = fingerprint([`${WIKI}/pro`, `${WIKI}/perso`, `${RAW}/pro`, `${RAW}/perso`, `${RULES}/pro`, `${RULES}/perso`, 'orgs.json']);
    const r = kioku(['add-domain', 'asso', '--preset', 'minimal', '--vault', vault]);
    assert.equal(r.status, EXIT.ok, r.stdout);
    assert.deepEqual(fingerprint([`${WIKI}/pro`, `${WIKI}/perso`, `${RAW}/pro`, `${RAW}/perso`, `${RULES}/pro`, `${RULES}/perso`, 'orgs.json']), before);
    const cfg = JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'));
    assert.deepEqual(cfg.domains.map((d) => d.id), ['pro', 'perso', 'asso']);
    assert.ok(existsSync(path.join(vault, RULES, 'asso', 'rules.md')));
    assert.match(r.stdout, /3 domaine\(s\)/);
  });

  test('description et preset : repris dans la configuration et les regles', () => {
    kioku(['add-domain', 'club', '--preset', 'perso', '--description', 'Le club de sport', '--vault', vault]);
    const cfg = JSON.parse(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'));
    assert.equal(cfg.domains.find((d) => d.id === 'club').description, 'Le club de sport');
    assert.match(readFileSync(path.join(vault, RULES, 'club', 'rules.md'), 'utf8'), /vie privée/);
  });

  test('Covers AE2 : verrou Plaud detenu par un processus vivant : refus, arbre inchange', () => {
    mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
    writeFileSync(path.join(vault, 'tools', 'plaud-sync', '.lock.json'), JSON.stringify({ pid: process.pid, started: 'x' }));
    const before = readFileSync(path.join(vault, 'kioku.config.json'), 'utf8');
    const r = kioku(['add-domain', 'asso', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /circuit Plaud tourne/);
    assert.equal(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'), before);
    assert.ok(!existsSync(path.join(vault, WIKI, 'asso')));
  });

  test('domaine existant, nom invalide, nom reserve, preset inconnu : refus sans rien ecrire', () => {
    const before = readFileSync(path.join(vault, 'kioku.config.json'), 'utf8');
    for (const args of [['pro'], ['Pro'], ['heritage'], ['a_b'], ['asso', '--preset', 'inconnu']]) {
      const r = kioku(['add-domain', ...args, '--vault', vault]);
      assert.equal(r.status, EXIT.precondition, args.join(' '));
    }
    assert.equal(readFileSync(path.join(vault, 'kioku.config.json'), 'utf8'), before);
    assert.ok(!existsSync(path.join(vault, WIKI, 'asso')));
  });

  test('un dossier orphelin du meme nom n est pas reutilise en silence', () => {
    mkdirSync(path.join(vault, WIKI, 'asso'), { recursive: true });
    const r = kioku(['add-domain', 'asso', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /deja present sur le disque/);
  });

  test('Covers AE3 : une garde qui laisse passer asso vers pro : code cloisonnement, nomme en premier', () => {
    // Garde factice branchee a la place de la vraie (meme nom de fichier, autre dossier) : elle laisse tout passer.
    mkdirSync(path.join(root, 'poreuse'));
    const fake = path.join(root, 'poreuse', 'guard.mjs');
    writeFileSync(fake, 'process.exit(0);\n');
    const settings = path.join(vault, '.claude', 'settings.json');
    writeFileSync(settings, readFileSync(settings, 'utf8').replace(GUARD, fake));
    const r = kioku(['add-domain', 'asso', '--vault', vault]);
    assert.equal(r.status, EXIT.isolation);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /cloisonnement n'est pas prouve/);
    assert.match(lines[2], /^CLOISONNEMENT  la garde laisse passer/);
  });

  test('en session Claude hors setup : refus', () => {
    const r = kioku(['add-domain', 'asso', '--vault', vault], { CLAUDECODE: '1', VAULT_MODE: 'ingest' });
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /session setup/);
  });
});

describe('doctor', () => {
  // La garde du projet est ce qui est sonde ici : hook de repli, pas le plugin.
  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b,c', '--guard-hook']).status, EXIT.ok));

  test('garde non branchee : code cloisonnement, meme si la garde existe', () => {
    writeFileSync(path.join(vault, '.claude', 'settings.json'), '{}\n');
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.isolation);
    assert.match(r.stdout, /garde non branchee : ni hook PreToolUse de garde/);
  });

  test('plugin kioku active, sans hook projet : garde reconnue (source plugin), matrice sur la garde du core', () => {
    writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kioku@local': true } }));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.ok, r.stdout);
    assert.match(r.stdout, /garde \(plugin\)/);
    assert.match(r.stdout, /seule la sonde reelle \(--live\) prouve/);
  });

  test('plugin desactive (false) : pas de garde', () => {
    writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kioku@local': false } }));
    assert.equal(kioku(['doctor', '--vault', vault]).status, EXIT.isolation);
  });

  test('hook projet ET plugin actif : double garde signalee', () => {
    const settings = path.join(vault, '.claude', 'settings.json');
    const data = JSON.parse(readFileSync(settings, 'utf8'));
    writeFileSync(settings, JSON.stringify({ ...data, enabledPlugins: { 'kioku@local': true } }));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /double garde/);
  });
});

describe('doctor --live (faux claude : aucune vraie session)', () => {
  // Un faux `claude` qui ecrit un stream-json fige : FAKE_PROBE dit ce que la garde a repondu a la lecture.
  let fake;
  const fakeClaude = (scenario) => {
    fake = path.join(root, 'faux-claude.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const s = ${JSON.stringify(scenario)};
const target = process.argv[process.argv.indexOf('-p') + 1].match(/: (\\S+)\\. Ne fais/)[1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', plugins: s.plugins ?? [] });
if (s.read !== false) out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: target } }] } });
if (s.result) out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: s.result.error, content: s.result.text }] } });
out({ type: 'result', subtype: 'success', result: 'ok' });
`,
    );
    chmodSync(fake, 0o755);
    return fake;
  };
  const live = (scenario, settingsData) => {
    if (settingsData) writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify(settingsData));
    return kioku(['doctor', '--live', '--vault', vault], { KIOKU_CLAUDE: fakeClaude(scenario) });
  };
  const REFUS = { error: true, text: 'PreToolUse:Read hook error: [node guard.mjs]: Session query/a. On requete l or uniquement' };

  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b', '--guard-hook']).status, EXIT.ok));

  test('la garde refuse la lecture : cloisonnement prouve par la sonde reelle', () => {
    const r = live({ result: REFUS });
    assert.equal(r.status, EXIT.ok, r.stdout);
    assert.match(r.stdout, /sonde reelle : une session a est refusee par la garde sur b/);
  });

  test('la lecture aboutit : cloisonnement non prouve, nomme en premier', () => {
    const r = live({ result: { error: false, text: 'contenu' } });
    assert.equal(r.status, EXIT.isolation);
    assert.match(r.stdout.split('\n')[1], /^CLOISONNEMENT  sonde reelle : la lecture a abouti/);
  });

  test('refus d une autre nature (fichier absent) : ne vaut pas preuve', () => {
    const r = live({ result: { error: true, text: 'File does not exist.' } });
    assert.equal(r.status, EXIT.isolation);
    assert.match(r.stdout, /pas par la garde/);
  });

  test('la session ne tente pas la lecture : sonde non concluante', () => {
    assert.equal(live({ read: false }).status, EXIT.isolation);
  });

  test('plugin active mais absent de la session : cloisonnement non prouve', () => {
    const r = live({ result: REFUS, plugins: [] }, { enabledPlugins: { 'kioku@local': true } });
    assert.equal(r.status, EXIT.isolation);
    assert.match(r.stdout, /plugin kioku est active mais absent de la session/);
  });

  test('plugin active et present : prouve', () => {
    const r = live({ result: REFUS, plugins: [{ name: 'kioku' }] }, { enabledPlugins: { 'kioku@local': true } });
    assert.equal(r.status, EXIT.ok, r.stdout);
  });

  test('disableAllHooks : code cloisonnement', () => {
    writeFileSync(path.join(vault, '.claude', 'settings.local.json'), '{"disableAllHooks": true}\n');
    assert.equal(kioku(['doctor', '--vault', vault]).status, EXIT.isolation);
  });

  test('hook de garde qui ne couvre pas Bash : code cloisonnement', () => {
    const settings = path.join(vault, '.claude', 'settings.json');
    writeFileSync(settings, readFileSync(settings, 'utf8').replace('|Bash', ''));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.isolation);
    assert.match(r.stdout, /ne couvre pas Bash/);
  });

  test('regles d un domaine absentes : a corriger (code 1), cloisonnement toujours prouve', () => {
    rmSync(path.join(vault, RULES, 'b', 'rules.md'));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /rules\.md absent/);
  });

  test('configuration absente, squelette present : coffre abime, marqueurs nommes', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /coffre abime : kioku\.config\.json absent/);
    assert.match(r.stdout, new RegExp(`${WIKI}\\b`));
    assert.match(r.stdout, /la garde refuse tout/);
  });

  test('lance dans un sous-dossier d un coffre sain : ouvre la racine, pas « coffre abime »', () => {
    const sub = path.join(vault, WIKI, 'a');
    const r = kioku(['doctor', '--vault', sub]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /sous-dossier du coffre/);
    assert.match(r.stdout, /ouvre la racine du coffre/);
    assert.doesNotMatch(r.stdout, /coffre abime/);
  });

  test('dossier sans configuration ni marqueur : pas un coffre, la garde ne s y applique pas', () => {
    const empty = path.join(root, 'vide');
    mkdirSync(empty);
    const r = kioku(['doctor', '--vault', empty]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /n'est pas un coffre \(aucun marqueur\)/);
    assert.doesNotMatch(r.stdout, /coffre abime/);
  });

  test('configuration invalide : refus nomme, pas confondu avec un coffre abime', () => {
    writeFileSync(path.join(vault, 'kioku.config.json'), '{ pas du json');
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /configuration du coffre illisible/);
    assert.doesNotMatch(r.stdout, /coffre abime/);
  });
});

describe('usage', () => {
  test('Covers AE5 : aucune sous-commande ne retire ni ne renomme ; l usage dit la marche manuelle', () => {
    for (const cmd of ['remove-domain', 'rename-domain', 'drop', '']) {
      const r = kioku(cmd ? [cmd, 'x'] : []);
      assert.equal(r.status, EXIT.precondition, cmd);
      assert.match(r.stdout, /Retirer ou renommer un domaine ne passe pas par ce CLI/);
    }
  });
});

describe('sous-commandes relais (decision 1)', () => {
  test('la gate lancee depuis un terminal (sans CLAUDE_PROJECT_DIR) vise le dossier courant, pas le core', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.ok);
    const env = { ...process.env, HOME: path.join(root, 'home') };
    for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'VAULT_MODE', 'VAULT_DOMAIN']) delete env[k];
    const r = spawnSync(process.execPath, [KIOKU, 'audit', 'a'], { cwd: vault, env, encoding: 'utf8' });
    assert.doesNotMatch(r.stdout + r.stderr, /configuration du coffre absente/, r.stdout + r.stderr);
    assert.match(r.stdout, /wiki\/a : 0 pages/);
  });

  test('session, dashboard, plaud : l outil du core vise, arguments passes tels quels', async () => {
    const { toolCommand } = await import('./kioku.mjs');
    const rel = (argv) => toolCommand(argv).map((a) => (path.isAbsolute(a) ? path.relative(path.dirname(KIOKU), a) : a));
    assert.deepEqual(rel(['session', 'a']), ['vault.mjs', '--domain', 'a']);
    assert.deepEqual(rel(['session', 'a', '--mode', 'ingest']), ['vault.mjs', '--domain', 'a', '--mode', 'ingest']);
    assert.deepEqual(rel(['session', '--mode', 'triage']), ['vault.mjs', '--mode', 'triage']);
    assert.deepEqual(rel(['session', 'a', '--', '--resume']), ['vault.mjs', '--domain', 'a', '--', '--resume']);
    assert.deepEqual(rel(['dashboard', 'all']), [path.join('dashboard', 'run.mjs'), 'all']);
    assert.deepEqual(rel(['dashboard', 'a', '--serve']), [path.join('dashboard', 'serve.mjs'), 'a']);
    assert.deepEqual(rel(['plaud', '--dry-run']), [path.join('plaud-sync', 'run.mjs'), '--vault', '.', '--dry-run']);
    assert.equal(toolCommand(['doctor']), null);
  });

  test('chaque script genere par init se resout vers un outil ou une commande connue', async () => {
    const { toolCommand, GATE_COMMANDS } = await import('./kioku.mjs');
    const { managedScripts } = await import('./managed.mjs');
    for (const [k, v] of Object.entries(managedScripts(['a', 'b'], { plaud: true }))) {
      const argv = v.split(' ').slice(1);
      const known = toolCommand(argv) || GATE_COMMANDS.includes(argv[0]) || ['doctor'].includes(argv[0]);
      assert.ok(known, `${k} : ${v}`);
      const tool = toolCommand(argv)?.[0];
      if (tool) assert.ok(existsSync(tool), `${k} : ${tool} absent du core`);
    }
  });
});

// Principe du 2026-11-02 : un coffre en service = sortie d'init + data + personnalisations declarees. Un coffre a
// l'ancienne forme, passe par upgrade --write, ne doit differer d'un init neuf que par ces personnalisations.
describe('conformite : coffre ancien + upgrade = init + personnalisations', () => {
  const ADMIS = new Set(['CLAUDE.md', 'orgs.json', 'domains/a/rules.md', 'domains/b/rules.md', 'tools/plaud-sync/seen.json', 'tools/plaud-sync/exclusions.txt', '.claude/commands/digest.md', 'docs/notes.md']);
  const DATA = /^(wiki|raw|silver)\//;
  const files = (dir) => {
    const out = new Map();
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.set(path.relative(dir, p).split(path.sep).join('/'), readFileSync(p, 'utf8'));
      }
    };
    walk(dir);
    return out;
  };
  // Les journaux portent l'heure de creation : on compare leur structure, pas l'horodatage.
  const normalize = (rel, text) => (rel.endsWith('/log.md') ? text.replace(/\[\d{4}-\d\d-\d\d \d\d:\d\d\]/g, '[T]') : text);

  test('seules les personnalisations listees, les scripts maison et le hors-bloc du .gitignore different', () => {
    const fresh = path.join(root, 'neuf');
    assert.equal(kioku(['init', fresh, '--domains', 'a,b', '--org', 'a', '--plaud']).status, EXIT.ok);

    // Le coffre ancien : meme init, puis ramene a l'ancienne forme, puis personnalise.
    assert.equal(kioku(['init', vault, '--domains', 'a,b', '--org', 'a', '--plaud']).status, EXIT.ok);
    const pkgFile = path.join(vault, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    pkg.name = 'mon-coffre';
    pkg.description = 'description maison';
    for (const [k, v] of Object.entries(pkg.scripts)) if (v.startsWith('kioku session ')) pkg.scripts[k] = `kioku ancienne-forme ${k}`;
    delete pkg.scripts['dashboard:serve:b'];
    pkg.scripts.digest = 'claude -p /digest';
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(path.join(vault, '.gitignore'), '.DS_Store\n');
    rmSync(path.join(vault, '.gitattributes'));
    rmSync(path.join(vault, WIKI, 'b', 'index.md'));
    rmSync(path.join(vault, WIKI, 'b', 'log.md'));
    const cfgFile = path.join(vault, 'kioku.config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    delete cfg.default_session;
    delete cfg.modules.dashboard;
    writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    writeFileSync(path.join(vault, 'CLAUDE.md'), 'contexte maison\n');
    writeFileSync(path.join(vault, 'domains', 'a', 'rules.md'), `${readFileSync(path.join(vault, 'domains', 'a', 'rules.md'), 'utf8')}\nregle maison\n`);
    mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
    writeFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), '[]\n');
    mkdirSync(path.join(vault, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(vault, '.claude', 'commands', 'digest.md'), 'maison\n');
    mkdirSync(path.join(vault, 'docs'));
    writeFileSync(path.join(vault, 'docs', 'notes.md'), 'maison\n');
    writeFileSync(path.join(vault, WIKI, 'a', 'concepts', 'x.md'), 'donnee\n');

    const r = kioku(['upgrade', '--write', '--vault', vault]);
    assert.equal(r.status, EXIT.ok, r.stdout);

    const got = files(vault);
    const want = files(fresh);
    const ecarts = [];
    for (const rel of new Set([...got.keys(), ...want.keys()])) {
      if (DATA.test(rel) && !/\/(index|log|overview)\.md$/.test(rel) && !rel.endsWith('.gitkeep')) continue;
      if (ADMIS.has(rel)) continue;
      const g = got.has(rel) ? normalize(rel, got.get(rel)) : undefined;
      const w = want.has(rel) ? normalize(rel, want.get(rel)) : undefined;
      if (g === w) continue;
      if (rel === 'package.json') {
        const gp = JSON.parse(g);
        const wp = JSON.parse(w);
        const maison = Object.keys(gp.scripts).filter((k) => !(k in wp.scripts));
        assert.deepEqual(maison, ['digest'], 'seul le script maison s ajoute');
        for (const [k, v] of Object.entries(wp.scripts)) assert.equal(gp.scripts[k], v, `script gere ${k}`);
        continue;
      }
      if (rel === '.gitignore') {
        assert.ok(g.startsWith('.DS_Store\n'), 'lignes maison conservees');
        assert.ok(g.includes(w.trim()), 'bloc gere identique a init');
        continue;
      }
      if (rel === 'kioku.config.json') {
        assert.deepEqual(JSON.parse(g), JSON.parse(w));
        continue;
      }
      ecarts.push(rel);
    }
    assert.deepEqual(ecarts, [], `ecarts non admis : ${ecarts.join(', ')}`);
  });
});

describe('upgrade : aucune reecriture de pure mise en forme', () => {
  test('config et settings deja conformes, ecrits sur une ligne : laisses tels quels', () => {
    assert.equal(kioku(['init', vault, '--domains', 'a']).status, EXIT.ok);
    for (const rel of ['kioku.config.json', path.join('.claude', 'settings.json')]) {
      const f = path.join(vault, rel);
      writeFileSync(f, `${JSON.stringify(JSON.parse(readFileSync(f, 'utf8')))}\n`);
    }
    const r = kioku(['upgrade', '--vault', vault]);
    assert.match(r.stdout, /deja a la forme courante/, r.stdout);
  });
});
