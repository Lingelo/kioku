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
    const settings = readFileSync(path.join(vault, '.claude', 'settings.json'), 'utf8');
    assert.ok(settings.includes(GUARD), 'le hook vise la garde du core');
  });

  test('schema commun : pose dans .kioku/, importe par le CLAUDE.md, noms nus sans plugin et prefixes avec', () => {
    kioku(['init', vault, '--domains', 'a,b'], { KIOKU_PLUGIN: '' });
    const schema = readFileSync(path.join(vault, '.kioku', 'schema.md'), 'utf8');
    assert.match(schema, /^## 7\. La gate/m);
    assert.doesNotMatch(schema, /kioku:/, 'sans plugin : /ingest, reviewer');
    assert.match(readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), /^@\.kioku\/schema\.md$/m);
    const other = path.join(root, 'autre');
    kioku(['init', other, '--domains', 'a,b'], { KIOKU_PLUGIN: 'kioku' });
    assert.match(readFileSync(path.join(other, '.kioku', 'schema.md'), 'utf8'), /\/kioku:ingest/);
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
    assert.equal(cfg.modules, undefined);
    assert.ok(!existsSync(path.join(vault, 'tools')));
    assert.doesNotMatch(readFileSync(path.join(vault, '.gitignore'), 'utf8'), /plaud/);
  });

  test('en session Claude hors setup : refus ; en setup : permis', () => {
    assert.equal(kioku(['init', vault], { CLAUDECODE: '1', VAULT_MODE: 'query' }).status, EXIT.precondition);
    assert.ok(!existsSync(vault));
    assert.equal(kioku(['init', vault, '--domains', 'a,b'], { CLAUDECODE: '1', VAULT_MODE: 'setup' }).status, EXIT.ok);
  });
});

describe('add-domain', () => {
  beforeEach(() => {
    const r = kioku(['init', vault, '--domains', 'pro,perso', '--org', 'pro']);
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
  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b,c']).status, EXIT.ok));

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

  beforeEach(() => assert.equal(kioku(['init', vault, '--domains', 'a,b']).status, EXIT.ok));

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

  test('configuration absente : refus nomme', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    const r = kioku(['doctor', '--vault', vault]);
    assert.equal(r.status, EXIT.precondition);
    assert.match(r.stdout, /configuration du coffre absente/);
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
