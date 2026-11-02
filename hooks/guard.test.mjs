/**
 * Tests de la garde (plan core/data) : caracterisation de U1, puis domaines lus dans la configuration (U3).
 * `node --test hooks/guard.test.mjs`
 * La garde est lancee comme le fait Claude Code : entree JSON sur stdin, VAULT_MODE / VAULT_DOMAIN dans
 * l'environnement, code 2 = refus. Coffre factice dans un dossier temporaire : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const GUARD = path.resolve('hooks/guard.mjs');
// Lancee depuis un autre dossier (relecture d'un patch), la suite vise la garde passee dans KIOKU_GUARD.
const TARGET = process.env.KIOKU_GUARD ?? GUARD;

let vault;
const config = (data) => writeFileSync(path.join(vault, 'kioku.config.json'), JSON.stringify(data));
// Le coffre des tests U1 : les deux domaines d'aujourd'hui, registre a son emplacement actuel, defaut query/pro.
const TWO = {
  version: 1,
  domains: [{ id: 'pro', extensions: { org: { registry: 'hooks/orgs.json' } } }, { id: 'perso' }],
  default_session: { mode: 'query', domain: 'pro' },
};
const THREE = { version: 1, domains: [{ id: 'a', extensions: { org: { registry: 'etat/orgs.json' } } }, { id: 'b' }, { id: 'c' }] };

beforeEach(() => {
  vault = realpathSync(mkdtempSync(path.join(tmpdir(), 'vault-guard-test-')));
  config(TWO);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

// La session de test herite peut-etre de VAULT_MODE / VAULT_DOMAIN : on les retire, puis on pose ceux du cas.
const guard = (session, payload, raw) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: vault };
  delete env.VAULT_MODE;
  delete env.VAULT_DOMAIN;
  if (session.mode !== undefined) env.VAULT_MODE = session.mode;
  if (session.domain !== undefined) env.VAULT_DOMAIN = session.domain;
  const input = raw ?? JSON.stringify({ ...payload, cwd: vault });
  return spawnSync(process.execPath, [TARGET], { input, env, encoding: 'utf8' }).status;
};
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

const OK = 0;
const REFUS = 2;

describe('session query/pro', () => {
  const s = { mode: 'query', domain: 'pro' };
  test('lit le wiki de son domaine', () => assert.equal(guard(s, read('wiki/pro/x.md')), OK));
  test('ne lit ni le brut, ni l autre domaine, ni la quarantaine', () => {
    assert.equal(guard(s, read('raw/pro/x.md')), REFUS);
    assert.equal(guard(s, read('wiki/perso/x.md')), REFUS);
    assert.equal(guard(s, read('quarantine/pro/x.json')), REFUS);
    assert.equal(guard(s, read('silver/pro/x.md')), REFUS);
  });
  test('ecrit sous .candidats de son domaine, pas dans le wiki hors index et log', () => {
    assert.equal(guard(s, write('.candidats/wiki/pro/concepts/x.md')), OK);
    assert.equal(guard(s, write('wiki/pro/index.md')), OK);
    assert.equal(guard(s, write('wiki/pro/concepts/x.md')), REFUS);
    assert.equal(guard(s, write('wiki/pro/overview.md')), REFUS);
  });
  test('Bash : ni le brut, ni l historique git, ni une recherche recursive sans dossier', () => {
    assert.equal(guard(s, bash('cat raw/pro/x.md')), REFUS);
    assert.equal(guard(s, bash('git show HEAD')), REFUS);
    assert.equal(guard(s, bash('grep -r foo .')), REFUS);
    assert.equal(guard(s, bash('grep -r foo wiki/pro')), OK);
  });
  test('Bash : le texte d un message de commit n est pas analyse', () => {
    assert.equal(guard(s, bash('git commit -m "diff du 21/09"')), OK);
  });
  test('Grep sans path : refuse', () => {
    assert.equal(guard(s, { tool_name: 'Grep', tool_input: { pattern: 'x' } }), REFUS);
  });
});

describe('session ingest/perso', () => {
  const s = { mode: 'ingest', domain: 'perso' };
  test('lit le brut et ecrit l argent de son domaine', () => {
    assert.equal(guard(s, read('raw/perso/x.md')), OK);
    assert.equal(guard(s, write('silver/perso/x.md')), OK);
  });
  test('l instantane heritage est ferme', () => {
    assert.equal(guard(s, read('silver/perso/heritage/x.md')), REFUS);
  });
  test('wiki : overview s ecrit en place, une page jamais', () => {
    assert.equal(guard(s, write('wiki/perso/overview.md')), OK);
    assert.equal(guard(s, write('wiki/perso/sources/x.md')), REFUS);
  });
  test('l autre domaine est ferme', () => {
    assert.equal(guard(s, read('raw/pro/x.md')), REFUS);
    assert.equal(guard(s, read('wiki/pro/x.md')), REFUS);
  });
});

describe('session triage', () => {
  test('lit l entrant, pas le wiki', () => {
    const s = { mode: 'triage' };
    assert.equal(guard(s, read('inbox/x.md')), OK);
    assert.equal(guard(s, read('wiki/pro/x.md')), REFUS);
  });
  test('avec un domaine declare (circuit Plaud) : meme regles', () => {
    const s = { mode: 'triage', domain: 'pro' };
    assert.equal(guard(s, read('inbox/x.md')), OK);
    assert.equal(guard(s, read('wiki/pro/x.md')), REFUS);
  });
});

describe('zone de la garde', () => {
  for (const mode of ['query', 'ingest', 'triage']) {
    test(`Edit du registre des organisations refuse en ${mode}`, () => {
      assert.equal(guard({ mode, domain: 'pro' }, edit('hooks/orgs.json')), REFUS);
    });
  }
  test('Bash qui ecrit dans les hooks : refuse', () => {
    assert.equal(guard({ mode: 'query', domain: 'pro' }, bash('echo x > .claude/hooks/guard.mjs')), REFUS);
  });
});

describe('echec ferme', () => {
  test('domaine ou mode inconnus : refus', () => {
    assert.equal(guard({ mode: 'query', domain: 'autre' }, read('wiki/pro/x.md')), REFUS);
    assert.equal(guard({ mode: 'x', domain: 'pro' }, read('wiki/pro/x.md')), REFUS);
  });
  test('entree illisible : refus', () => {
    assert.equal(guard({ mode: 'query', domain: 'pro' }, null, 'pas du json'), REFUS);
  });
  test('sans VAULT_MODE ni VAULT_DOMAIN : vaut le default_session de la configuration', () => {
    assert.equal(guard({}, read('wiki/pro/x.md')), OK);
    assert.equal(guard({}, read('wiki/perso/x.md')), REFUS);
  });
});

describe('U3 : configuration du coffre', () => {
  test('configuration absente : tout est refuse, meme le wiki de la session', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('wiki/pro/x.md')), REFUS);
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('README.md')), REFUS);
  });
  test('configuration invalide : refus', () => {
    writeFileSync(path.join(vault, 'kioku.config.json'), '{ pas du json');
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('wiki/pro/x.md')), REFUS);
  });
  test('sans variables et sans default_session : refus (R17b)', () => {
    config({ version: 1, domains: [{ id: 'pro' }, { id: 'perso' }] });
    assert.equal(guard({}, read('wiki/pro/x.md')), REFUS);
  });
  test('domaine seul, sans mode : refus', () => {
    assert.equal(guard({ domain: 'pro' }, read('wiki/pro/x.md')), REFUS);
  });
  test('query/pro sans domaine : refus', () => {
    assert.equal(guard({ mode: 'query' }, read('wiki/pro/x.md')), REFUS);
  });
});

describe('U3 : echec ferme sur un module de configuration d une autre version', () => {
  test('config.mjs ancien (sans protectedPaths ni defaultSession) : refus, jamais code 1', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-copy-'));
    try {
      writeFileSync(path.join(dir, 'guard.mjs'), readFileSync(TARGET, 'utf8'));
      writeFileSync(path.join(dir, 'config.mjs'), 'export const loadConfig = () => ({ domains: ["pro"], has: () => true });\n');
      const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' };
      const input = JSON.stringify({ ...read('wiki/pro/x.md'), cwd: vault });
      assert.equal(spawnSync(process.execPath, [path.join(dir, 'guard.mjs')], { input, env, encoding: 'utf8' }).status, REFUS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('U3 : trois domaines declares', () => {
  beforeEach(() => config(THREE));
  test('query/a : les deux autres domaines fermes, en lecture comme en shell', () => {
    const s = { mode: 'query', domain: 'a' };
    assert.equal(guard(s, read('wiki/a/x.md')), OK);
    assert.equal(guard(s, read('wiki/b/x.md')), REFUS);
    assert.equal(guard(s, read('wiki/c/x.md')), REFUS);
    assert.equal(guard(s, bash('cat wiki/c/x.md')), REFUS);
    assert.equal(guard(s, write('.candidats/wiki/b/concepts/x.md')), REFUS);
  });
  test('ingest/b : raw de b ouvert, ceux de a et c fermes', () => {
    const s = { mode: 'ingest', domain: 'b' };
    assert.equal(guard(s, read('raw/b/x.md')), OK);
    assert.equal(guard(s, read('raw/a/x.md')), REFUS);
    assert.equal(guard(s, read('raw/c/x.md')), REFUS);
    assert.equal(guard(s, bash('cat raw/c/x.md')), REFUS);
  });
  test('un domaine dont le nom prolonge celui de la session reste ferme', () => {
    config({ version: 1, domains: [{ id: 'a' }, { id: 'a-old' }] });
    const s = { mode: 'query', domain: 'a' };
    assert.equal(guard(s, read('wiki/a-old/x.md')), REFUS);
    assert.equal(guard(s, bash('cat wiki/a-old/x.md')), REFUS);
  });
  test('dossier de domaine non declare : ferme dans tous les modes', () => {
    for (const s of [{ mode: 'query', domain: 'a' }, { mode: 'ingest', domain: 'a' }, { mode: 'triage' }]) {
      assert.equal(guard(s, read('wiki/zzz/x.md')), REFUS);
      assert.equal(guard(s, read('raw/zzz/x.md')), REFUS);
    }
  });
});

describe('U3 : regles de domaine et zone de la garde etendue', () => {
  beforeEach(() => config(THREE));
  test('query/a : ses regles se lisent, celles des autres domaines non', () => {
    const s = { mode: 'query', domain: 'a' };
    assert.equal(guard(s, read('domains/a/rules.md')), OK);
    assert.equal(guard(s, read('domains/b/rules.md')), REFUS);
    assert.equal(guard(s, bash('cat domains/b/rules.md')), REFUS);
  });
  test('triage : aucune regle de domaine lisible', () => {
    assert.equal(guard({ mode: 'triage' }, read('domains/a/rules.md')), REFUS);
  });
  for (const mode of ['query', 'ingest']) {
    test(`${mode}/a : configuration, regles et registre jamais ecrits`, () => {
      const s = { mode, domain: 'a' };
      assert.equal(guard(s, edit('kioku.config.json')), REFUS);
      assert.equal(guard(s, edit('domains/a/rules.md')), REFUS);
      assert.equal(guard(s, write('domains/a/rules.md')), REFUS);
      assert.equal(guard(s, bash('echo x >> domains/a/rules.md')), REFUS);
      assert.equal(guard(s, bash('echo x > kioku.config.json')), REFUS);
      assert.equal(guard(s, edit('etat/orgs.json')), REFUS);
      assert.equal(guard(s, bash('cp /tmp/x etat/orgs.json')), REFUS);
    });
  }
  test('la configuration et le registre restent lisibles', () => {
    const s = { mode: 'query', domain: 'a' };
    assert.equal(guard(s, read('kioku.config.json')), OK);
    assert.equal(guard(s, read('etat/orgs.json')), OK);
  });
  test('triage : un domaine pose n ouvre pas ses regles', () => {
    assert.equal(guard({ mode: 'triage', domain: 'a' }, read('domains/a/rules.md')), REFUS);
  });
  test('le dossier de la garde est protege meme hors du coffre (cas du plugin)', () => {
    const s = { mode: 'query', domain: 'a' };
    assert.equal(guard(s, edit(path.join(path.dirname(TARGET), 'guard.mjs'))), REFUS);
    assert.equal(guard(s, edit(path.join(path.dirname(TARGET), 'config.mjs'))), REFUS);
  });
});

describe('U8 : mode de session setup', () => {
  beforeEach(() => config(THREE));
  const s = { mode: 'setup' };

  test('Covers AE4 : aucun contenu de domaine, la configuration et le registre se lisent', () => {
    for (const p of ['wiki/a/x.md', 'wiki/b/x.md', 'raw/a/x.md', 'silver/a/x.md', 'domains/a/rules.md', 'domains/b/rules.md', 'inbox/x.md', 'quarantine/a/x.json', '.candidats/wiki/a/concepts/x.md', '.verdicts/x.json']) {
      assert.equal(guard(s, read(p)), REFUS, p);
    }
    assert.equal(guard(s, read('kioku.config.json')), OK);
    assert.equal(guard(s, read('etat/orgs.json')), OK);
    assert.equal(guard(s, read('README.md')), OK);
  });

  test('un VAULT_DOMAIN pose en setup n ouvre aucun domaine', () => {
    assert.equal(guard({ mode: 'setup', domain: 'a' }, read('wiki/a/x.md')), REFUS);
    assert.equal(guard({ mode: 'setup', domain: 'a' }, read('domains/a/rules.md')), REFUS);
    assert.equal(guard({ mode: 'setup', domain: 'zzz' }, read('README.md')), REFUS, 'domaine non declare : refus');
  });

  test('aucune ecriture directe de la configuration, des regles ni du registre', () => {
    const cfgFile = ['kioku', 'config', 'json'].join('.');
    assert.equal(guard(s, write(cfgFile)), REFUS);
    assert.equal(guard(s, edit(cfgFile)), REFUS);
    assert.equal(guard(s, write('domains/d/rules.md')), REFUS);
    assert.equal(guard(s, bash(`echo x > ${cfgFile}`)), REFUS);
    assert.equal(guard(s, edit('etat/orgs.json')), REFUS);
    assert.equal(guard(s, write('wiki/a/index.md')), REFUS);
  });

  test('le CLI du coffre : init et add-domain en setup, doctor partout', () => {
    for (const cmd of ['node tools/kioku.mjs add-domain asso --preset perso', 'node /opt/core/bin/kioku init /tmp/v', 'kioku add-domain asso', 'node tools/kioku.mjs doctor']) {
      assert.equal(guard(s, bash(cmd)), OK, cmd);
    }
    assert.equal(guard({ mode: 'query', domain: 'a' }, bash('node tools/kioku.mjs doctor')), OK);
  });

  test('la description de add-domain est du texte libre : « du », « find », « tree » n y sont pas des commandes', () => {
    assert.equal(guard(s, bash('node tools/kioku.mjs add-domain essai --preset minimal --description "Domaine de test du skill"')), OK);
    assert.equal(guard(s, bash("node tools/kioku.mjs add-domain essai --description 'find tree rg'")), OK);
    // Une substitution reste visible de la garde, comme pour -m.
    assert.equal(guard(s, bash('node tools/kioku.mjs add-domain essai --description "$(cat wiki/a/x.md)"')), REFUS);
  });

  test('hors setup, kioku init et add-domain sont refuses', () => {
    for (const sess of [{ mode: 'query', domain: 'a' }, { mode: 'ingest', domain: 'a' }, { mode: 'triage' }]) {
      assert.equal(guard(sess, bash('node tools/kioku.mjs add-domain asso')), REFUS, sess.mode);
      assert.equal(guard(sess, bash('kioku init /tmp/v')), REFUS, sess.mode);
    }
  });

  test('en setup : ni gate, ni circuit Plaud, ni lanceur, ni dashboard, ni recherche recursive', () => {
    for (const cmd of [
      'kioku audit a',
      'kioku undecided',
      'kioku check .candidats/wiki/a/concepts/x.md',
      `node ${['.claude', 'hooks', 'vault.mjs'].join('/')} audit a`,
      'node tools/plaud-sync/run.mjs --dry-run',
      'node tools/dashboard/run.mjs a',
      'npm run pro',
      'npm run dashboard',
      'npm run undecided',
      'grep -r foo .',
      'cat wiki/a/x.md',
    ]) {
      assert.equal(guard(s, bash(cmd)), REFUS, cmd);
    }
    assert.equal(guard(s, bash('npm test')), OK, 'les tests ne lisent aucun domaine du coffre');
  });

  test('default_session setup explicite : admis, sans ouvrir de domaine', () => {
    config({ ...THREE, default_session: { mode: 'setup' } });
    assert.equal(guard({}, read('kioku.config.json')), OK);
    assert.equal(guard({}, read('wiki/a/x.md')), REFUS);
  });
});
