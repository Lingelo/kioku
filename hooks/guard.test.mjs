/**
 * Tests de la garde (plan core/data) : caracterisation de U1, puis domaines lus dans la configuration (U3).
 * `node --test hooks/guard.test.mjs`
 * La garde est lancee comme le fait Claude Code : entree JSON sur stdin, VAULT_MODE / VAULT_DOMAIN dans
 * l'environnement, code 2 = refus. Coffre factice dans un dossier temporaire : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// Session nue (ni VAULT_MODE ni VAULT_DOMAIN) ouverte sur un autre dossier projet ; projectDir null = variable absente.
const guardAt = (projectDir, payload) => {
  const env = { ...process.env };
  delete env.VAULT_MODE;
  delete env.VAULT_DOMAIN;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir !== null) env.CLAUDE_PROJECT_DIR = projectDir;
  const input = JSON.stringify({ ...payload, cwd: projectDir ?? vault });
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
  test('configuration absente, marqueur de coffre present : tout est refuse, meme le wiki de la session', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    mkdirSync(path.join(vault, 'wiki', 'pro'), { recursive: true });
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('wiki/pro/x.md')), REFUS);
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('README.md')), REFUS);
  });
  test('configuration invalide : refus, meme sans autre marqueur', () => {
    writeFileSync(path.join(vault, 'kioku.config.json'), '{ pas du json');
    assert.equal(guard({}, read('README.md')), REFUS);
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
      assert.equal(guard(sess, bash('kioku upgrade --write')), REFUS, `${sess.mode} : upgrade --write ecrit la configuration`);
      assert.equal(guard(sess, bash('kioku upgrade')), OK, `${sess.mode} : la simulation ne fait que lire`);
    }
    assert.equal(guard(s, bash('kioku upgrade --write')), OK, 'en setup');
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

  test('en setup, le socle des connecteurs (tools/connectors/) est refuse comme plaud-sync/', () => {
    for (const cmd of [
      'node tools/connectors/pending.mjs --state tools/plaud-sync list',
      'node tools\\connectors\\circuit.mjs',
      'cat tools/connectors/.lock.json',
      'node /opt/core/tools/connectors/pending.mjs --state x snapshot',
    ]) {
      assert.equal(guard(s, bash(cmd)), REFUS, cmd);
    }
    // Hors setup aussi (m9) : le socle des connecteurs est refuse dans toutes les sessions.
    assert.equal(guard({ mode: 'query', domain: 'a' }, bash('cat tools/connectors/.lock.json')), REFUS);
  });

  // init genere un script npm par domaine declare (`npm run a` ouvre une session query/a) : les noms viennent de la
  // configuration, pas d'une liste figee pro|perso.
  test('en setup, npm run <domaine declare> et ses variantes sont refuses ; un script sans rapport passe', () => {
    for (const cmd of ['npm run a', 'npm run c', 'npm run ingest:b', 'npm run lint:a', 'npm run audit:c', 'npm run dashboard:serve:b', 'npm a', 'npm run doctor && npm run a']) {
      assert.equal(guard(s, bash(cmd)), REFUS, cmd);
    }
    for (const cmd of ['npm run doctor', 'npm run alpha', 'npm run build']) assert.equal(guard(s, bash(cmd)), OK, cmd);
  });

  // Les sous-commandes relais du CLI (decision 1) n'ont plus vault.mjs, tools/dashboard/ ni plaud-sync/ dans la
  // commande : la garde les refuse par leur nom, comme les outils qu'elles lancent.
  const RELAY_CMDS = ['kioku session a', 'kioku session --mode ingest --domain b', 'kioku dashboard', 'kioku dashboard c --serve', 'kioku plaud --dry-run', 'node tools/kioku.mjs dashboard a', 'node /opt/core/bin/kioku session a', 'npm run doctor; kioku session a'];

  test('en setup, kioku session|dashboard|plaud sont refuses ; doctor reste admis', () => {
    for (const cmd of RELAY_CMDS) assert.equal(guard(s, bash(cmd)), REFUS, cmd);
    assert.equal(guard(s, bash('node tools/kioku.mjs doctor')), OK);
    assert.equal(guard(s, bash('kioku doctor --live')), OK);
  });

  test('en query et ingest, kioku dashboard est admis (le domaine est impose par resolveDomains)', () => {
    for (const sess of [{ mode: 'query', domain: 'a' }, { mode: 'ingest', domain: 'a' }]) {
      for (const cmd of ['kioku dashboard', 'kioku dashboard a --serve', 'node tools/kioku.mjs dashboard a']) assert.equal(guard(sess, bash(cmd)), OK, `${sess.mode} : ${cmd}`);
    }
  });

  test('default_session setup explicite : admis, sans ouvrir de domaine', () => {
    config({ ...THREE, default_session: { mode: 'setup' } });
    assert.equal(guard({}, read('kioku.config.json')), OK);
    assert.equal(guard({}, read('wiki/a/x.md')), REFUS);
  });
});

// Chantier 1 (plan apres U12) : installe au niveau utilisateur, le plugin branche la garde dans TOUS les projets.
// Hors coffre, elle ne s'applique pas ; un coffre abime (marqueur sans configuration lisible) reste ferme.
describe('chantier 1 : hors coffre, pas de garde ; coffre abime, refus', () => {
  const nu = {};
  const sansConfig = () => rmSync(path.join(vault, 'kioku.config.json'));

  test('dossier sans configuration ni marqueur : tout passe (projet ordinaire, ou dossier vide avant init)', () => {
    sansConfig();
    assert.equal(guard(nu, read('README.md')), OK);
    assert.equal(guard(nu, write('src/index.js')), OK);
    assert.equal(guard(nu, bash('npm test && git log')), OK);
    assert.equal(guard(nu, bash('node /opt/core/tools/kioku.mjs init .')), OK, 'kioku init dans un dossier vide');
  });

  for (const marker of ['wiki', 'raw', 'silver', 'domains', '.kioku']) {
    test(`marqueur ${marker}/ sans configuration : refus (coffre abime)`, () => {
      sansConfig();
      mkdirSync(path.join(vault, marker));
      assert.equal(guard(nu, read('README.md')), REFUS);
    });
  }

  test('un fichier nomme comme un marqueur ne fait pas un coffre', () => {
    sansConfig();
    writeFileSync(path.join(vault, 'wiki'), 'x');
    assert.equal(guard(nu, read('README.md')), OK);
  });

  test('projet ouvert dans un sous-dossier d un coffre (configuration chez un parent) : la garde ne se coupe pas', () => {
    const sub = path.join(vault, 'wiki', 'pro');
    mkdirSync(sub, { recursive: true });
    assert.equal(guardAt(sub, read('x.md')), REFUS);
  });

  test('projet ouvert dans un sous-dossier d un coffre abime (.kioku/ chez un parent) : refus', () => {
    sansConfig();
    mkdirSync(path.join(vault, '.kioku'));
    const sub = path.join(vault, 'projet');
    mkdirSync(sub);
    assert.equal(guardAt(sub, read('x.md')), REFUS);
  });

  test('hors coffre mais VAULT_MODE ou VAULT_DOMAIN pose : refus (session de coffre ouverte au mauvais endroit)', () => {
    sansConfig();
    assert.equal(guard({ mode: 'query', domain: 'pro' }, read('README.md')), REFUS);
    assert.equal(guard({ mode: 'setup' }, read('README.md')), REFUS);
    assert.equal(guard({ domain: 'pro' }, read('README.md')), REFUS);
  });

  test('sans CLAUDE_PROJECT_DIR : echec ferme garde (le repli vise le dossier du plugin, pas le projet)', () => {
    sansConfig();
    assert.equal(guardAt(null, read('README.md')), REFUS);
  });
});

// Revue de securite de la PR : une session ne doit pas pouvoir faire passer un coffre a « hors coffre » pour couper
// la garde (renommer les marqueurs, deplacer la configuration par un glob, renommer .claude/).
describe('chantier 1 : la sortie hors coffre ne s ouvre pas depuis une session', () => {
  const nu = {};
  test('renommer un marqueur ou .claude, sans slash final : refuse', () => {
    for (const cmd of ['mv wiki w', 'mv raw r', 'mv silver s', 'mv domains d', 'mv .kioku k', 'mv .claude c', 'cp -r wiki /tmp/x && rm -rf wiki', 'mv ./wiki w', 'ln -sfn /tmp wiki']) {
      assert.equal(guard(nu, bash(cmd)), REFUS, cmd);
    }
  });
  test('deplacer ou effacer la configuration par un glob : refuse', () => {
    for (const cmd of ['mv kioku.config.j* /tmp/kc.json', 'rm kioku.conf*', 'mv kioku.config.json? x', 'rm kioku.[c]onfig.json', 'mv kioku* /tmp/']) {
      assert.equal(guard(nu, bash(cmd)), REFUS, cmd);
    }
  });
  test('le scenario de la revue en un appel : refuse', () => {
    assert.equal(guard(nu, bash('mv wiki w && mv raw r && mv silver s && mv domains dd && mv .kioku k && mv kioku.config.j* /tmp/kc.json')), REFUS);
  });
  test('marqueurs et configuration retires par un autre chemin, settings Kioku restants : toujours refuse', () => {
    for (const d of ['wiki', 'raw', 'silver', 'domains', '.kioku']) rmSync(path.join(vault, d), { recursive: true, force: true });
    rmSync(path.join(vault, 'kioku.config.json'));
    mkdirSync(path.join(vault, '.claude'), { recursive: true });
    for (const settings of [{ enabledPlugins: { 'kioku@dojo': true } }, { enabledPlugins: { 'kioku@kioku': true } }, { extraKnownMarketplaces: { 'kioku-pin': { source: {} } } }, { enabledPlugins: { 'kioku@kioku-pin': true } }, { hooks: { PreToolUse: [{ hooks: [{ command: 'node "/x/guard.mjs"' }] }] } }]) {
      writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify(settings));
      assert.equal(guard(nu, read('wiki/perso/a.md')), REFUS, JSON.stringify(settings));
      assert.equal(guard(nu, edit('.claude/settings.json')), REFUS, JSON.stringify(settings));
    }
  });
  test('settings illisibles sans autre marqueur : refuse (echec ferme)', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    mkdirSync(path.join(vault, '.claude'), { recursive: true });
    writeFileSync(path.join(vault, '.claude', 'settings.json'), '{ casse');
    assert.equal(guard(nu, read('README.md')), REFUS);
  });
  // Projet ouvert dans le dossier personnel : <projet>/.claude/settings.json y est la configuration UTILISATEUR, ou le
  // plugin est active pour tous les projets. Avant le correctif, ~ passait pour un coffre abime et tout etait refuse.
  const guardHome = (home, payload, configDir) => {
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: home };
    delete env.VAULT_MODE;
    delete env.VAULT_DOMAIN;
    delete env.CLAUDE_CONFIG_DIR;
    if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
    return spawnSync(process.execPath, [TARGET], { input: JSON.stringify({ ...payload, cwd: home }), env, encoding: 'utf8' }).status;
  };
  const homeAvecPlugin = () => {
    for (const d of ['wiki', 'raw', 'silver', 'domains', '.kioku']) rmSync(path.join(vault, d), { recursive: true, force: true });
    rmSync(path.join(vault, 'kioku.config.json'));
    mkdirSync(path.join(vault, '.claude'), { recursive: true });
    writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kioku@dojo': true } }));
  };
  test('dossier personnel, plugin active dans les settings utilisateur : hors coffre', () => {
    homeAvecPlugin();
    assert.equal(guardHome(vault, read('.zshrc')), OK);
    assert.equal(guardHome(vault, bash('ls -la && cat .claude/settings.json')), OK);
    assert.equal(guardHome(vault, read('.zshrc'), path.join(vault, '.claude')), OK, 'CLAUDE_CONFIG_DIR = ~/.claude');
  });
  test('dossier personnel avec un marqueur de coffre : toujours refuse (les marqueurs priment)', () => {
    homeAvecPlugin();
    mkdirSync(path.join(vault, 'wiki'));
    assert.equal(guardHome(vault, read('.zshrc')), REFUS);
  });
  test('CLAUDE_CONFIG_DIR ailleurs : <projet>/.claude redevient une declaration du projet, refus', () => {
    homeAvecPlugin();
    assert.equal(guardHome(vault, read('.zshrc'), path.join(tmpdir(), 'autre-config-claude')), REFUS);
  });

  test('projet ordinaire avec ses propres settings (sans Kioku) : toujours hors coffre', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    mkdirSync(path.join(vault, '.claude'), { recursive: true });
    writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'autre@x': true } }));
    assert.equal(guard(nu, read('README.md')), OK);
    assert.equal(guard(nu, bash('mv build dist && rm -rf node_modules')), OK);
  });
});

// Correctif de securite : la garde comparait les chemins au caractere pres, sans suivre les liens ni etendre `~`.
// Sur un volume insensible a la casse (APFS par defaut, NTFS), `WIKI/perso/p.md` ouvrait l'autre domaine.
const caseInsensitiveFs = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-guard-casse-'));
  try {
    writeFileSync(path.join(dir, 'sonde'), '');
    return existsSync(path.join(dir, 'SONDE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const SANS_CASSE = caseInsensitiveFs ? false : 'volume temporaire sensible a la casse : cas sans objet ici (macOS/Windows seulement)';

describe('volume insensible a la casse', { skip: SANS_CASSE }, () => {
  const q = { mode: 'query', domain: 'pro' };
  const grep = (p, glob) => ({ tool_name: 'Grep', tool_input: { pattern: 'x', path: p, ...(glob ? { glob } : {}) } });
  beforeEach(() => {
    for (const d of ['wiki/pro', 'wiki/perso', 'raw/pro', 'quarantine/pro', '.verdicts', '.candidats/wiki/pro', 'hooks']) mkdirSync(path.join(vault, d), { recursive: true });
    writeFileSync(path.join(vault, 'wiki', 'perso', 'p.md'), 'secret');
    writeFileSync(path.join(vault, 'wiki', 'pro', 'x.md'), 'ok');
  });
  test('Read de l autre domaine, du brut, de la quarantaine, des verdicts en casse modifiee : refuse', () => {
    for (const p of ['WIKI/perso/p.md', 'wiki/PERSO/p.md', 'Wiki/Perso/absent.md', 'RAW/pro/x.md', 'Quarantine/pro/x.json', '.VERDICTS/x.json', 'SILVER/pro/x.md']) {
      assert.equal(guard(q, read(p)), REFUS, p);
    }
    assert.equal(guard(q, read(path.join(vault.toUpperCase(), 'wiki', 'perso', 'p.md'))), REFUS, 'racine du coffre en majuscules');
  });
  test('Write dans l or d un autre domaine, dans le wiki direct, la garde, en casse modifiee : refuse', () => {
    for (const p of ['WIKI/perso/x.md', 'wiki/PERSO/neuf/x.md', 'WIKI/pro/concepts/x.md', '.CANDIDATS/wiki/PERSO/x.md', 'KIOKU.CONFIG.JSON', 'Hooks/Orgs.json', 'RAW/pro/x.md']) {
      assert.equal(guard(q, write(p)), REFUS, p);
    }
    assert.equal(guard({ mode: 'ingest', domain: 'pro' }, write('SILVER/perso/x.md')), REFUS);
  });
  test('Grep et Glob : path ou motif en casse modifiee : refuse', () => {
    assert.equal(guard(q, grep('WIKI/perso')), REFUS);
    assert.equal(guard(q, grep('RAW/pro')), REFUS);
    assert.equal(guard(q, grep('wiki/pro', 'WIKI/PERSO/**')), REFUS);
    assert.equal(guard(q, { tool_name: 'Glob', tool_input: { pattern: '../Wiki/Perso/*.md', path: 'wiki/pro' } }), REFUS);
  });
  test('Bash : zone ou commande en casse modifiee : refuse', () => {
    for (const c of ['cat WIKI/perso/p.md', 'cat Raw/pro/x.md', 'ls .Verdicts', 'cat QUARANTINE/pro/x.json', 'echo x > WIKI/pro/y.md', 'MV Wiki w', 'RG secret', 'GIT show HEAD:x']) {
      assert.equal(guard(q, bash(c)), REFUS, c);
    }
  });
  test('operations legitimes : casse exacte, et casse modifiee sur son propre domaine, autorisees', () => {
    assert.equal(guard(q, read('wiki/pro/x.md')), OK);
    assert.equal(guard(q, read('WIKI/PRO/x.md')), OK, 'meme fichier sur ce volume : la garde ne ferme pas a tort');
    assert.equal(guard(q, write('.candidats/wiki/pro/concepts/x.md')), OK);
    assert.equal(guard(q, write('wiki/pro/index.md')), OK);
    assert.equal(guard(q, grep('wiki/pro')), OK);
    assert.equal(guard(q, bash('cat wiki/pro/x.md')), OK);
    assert.equal(guard(q, bash('ls -lrt wiki/pro')), OK, 'ls -r (tri inverse) n est pas une recherche recursive');
    assert.equal(guard(q, read('README.md')), OK);
  });
});

describe('chemins canoniques : ~ et liens symboliques', () => {
  const q = { mode: 'query', domain: 'pro' };
  beforeEach(() => {
    for (const d of ['wiki/pro', 'wiki/perso', '.candidats/wiki/pro']) mkdirSync(path.join(vault, d), { recursive: true });
    writeFileSync(path.join(vault, 'wiki', 'perso', 'p.md'), 'secret');
    writeFileSync(path.join(vault, 'wiki', 'pro', 'x.md'), 'ok');
  });
  // HOME = dossier parent du coffre : `~/<coffre>/...` designe le coffre.
  const guardHome = (payload) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, HOME: path.dirname(vault), VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' };
    return spawnSync(process.execPath, [TARGET], { input: JSON.stringify({ ...payload, cwd: vault }), env, encoding: 'utf8' }).status;
  };
  test('~, $HOME, ${HOME} vers l autre domaine : refuse ; vers son domaine : autorise', () => {
    const base = path.basename(vault);
    for (const h of ['~', '$HOME', '${HOME}']) {
      assert.equal(guardHome(read(`${h}/${base}/wiki/perso/p.md`)), REFUS, h);
      assert.equal(guardHome(write(`${h}/${base}/wiki/perso/x.md`)), REFUS, h);
      assert.equal(guardHome({ tool_name: 'Grep', tool_input: { pattern: 'x', path: `${h}/${base}/wiki/perso` } }), REFUS, h);
    }
    assert.equal(guardHome(read(`~/${base}/wiki/pro/x.md`)), OK);
  });
  test('lien symbolique sous son domaine vers l autre domaine : refuse', () => {
    symlinkSync('../perso', path.join(vault, 'wiki', 'pro', 'lien'));
    assert.equal(guard(q, read('wiki/pro/lien/p.md')), REFUS);
    assert.equal(guard(q, write('wiki/pro/lien/index.md')), REFUS);
    assert.equal(guard(q, { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'wiki/pro/lien' } }), REFUS);
    // `..` apres un lien : le systeme remonte depuis la cible (wiki/), pas depuis le lien (wiki/pro/).
    assert.equal(guard(q, read('wiki/pro/lien/../perso/p.md')), REFUS);
  });
  test('lien pendant sous .candidats vers l or d un autre domaine : Write refuse', () => {
    symlinkSync('../../../wiki/perso/neuf.md', path.join(vault, '.candidats', 'wiki', 'pro', 'piege.md'));
    assert.equal(guard(q, write('.candidats/wiki/pro/piege.md')), REFUS);
  });
  test('lien hors du coffre vers l autre domaine : refuse', () => {
    const out = realpathSync(mkdtempSync(path.join(tmpdir(), 'vault-guard-dehors-')));
    try {
      symlinkSync(path.join(vault, 'wiki', 'perso'), path.join(out, 'raccourci'));
      assert.equal(guard(q, read(path.join(out, 'raccourci', 'p.md'))), REFUS);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  test('boucle de liens : refuse (dans le doute)', () => {
    symlinkSync('boucle', path.join(vault, 'wiki', 'pro', 'boucle'));
    assert.equal(guard(q, read('wiki/pro/boucle/x.md')), REFUS);
  });
});

// m9 : un circuit de capture se lance depuis le terminal de l'utilisateur, jamais depuis une session du coffre.
describe('circuits de capture refuses dans toutes les sessions', () => {
  beforeEach(() => config(THREE));
  const SESSIONS = [{ mode: 'query', domain: 'a' }, { mode: 'ingest', domain: 'a' }, { mode: 'triage' }, { mode: 'setup' }];
  const CMDS = [
    'kioku plaud --dry-run',
    "kioku 'plaud' --skip-fetch",
    'kioku "plaud"',
    'node tools/kioku.mjs plaud',
    'npm run plaud:sync',
    'npm run-script plaud:dry-run',
    'npm rum plaud:pending',
    'npm urn plaud:drop -- x.md',
    'npm run "plaud:sync"',
    'node tools/plaud-sync/run.mjs --dry-run',
    'node tools/connectors/pending.mjs --state tools/plaud-sync list',
    'npm test && kioku plaud',
  ];
  for (const sess of SESSIONS) {
    test(`${sess.mode} : kioku plaud, ses scripts npm et ses outils refuses`, () => {
      for (const cmd of CMDS) assert.equal(guard(sess, bash(cmd)), REFUS, `${sess.mode} : ${cmd}`);
    });
  }
  test('la gate et doctor restent admis la ou ils l etaient ; un mot voisin ne declenche rien', () => {
    assert.equal(guard({ mode: 'ingest', domain: 'a' }, bash('kioku check .candidats/wiki/a/concepts/x.md')), OK);
    assert.equal(guard({ mode: 'query', domain: 'a' }, bash('kioku doctor')), OK);
    assert.equal(guard({ mode: 'query', domain: 'a' }, bash('npm run plaudit')), OK);
  });
});

// I6 : guillemets autour du sous-mot, et alias de `npm run`, pour les relais deja refuses en setup.
describe('setup : relais et scripts npm, sous toutes leurs formes', () => {
  beforeEach(() => config(THREE));
  test('kioku <sous-mot entre guillemets> et npm run-script / rum / urn refuses', () => {
    for (const cmd of [
      "kioku 'session' a",
      'kioku "dashboard" a',
      "node tools/kioku.mjs 'session' --mode ingest --domain b",
      'npm run-script a',
      'npm rum dashboard:serve:b',
      'npm urn ingest:a',
      "npm run 'lint:a'",
    ]) {
      assert.equal(guard({ mode: 'setup' }, bash(cmd)), REFUS, cmd);
    }
    assert.equal(guard({ mode: 'setup' }, bash('npm run-script doctor')), OK);
    assert.equal(guard({ mode: 'setup' }, bash("kioku 'doctor'")), OK);
  });
});

// B1 : le dossier des jetons OAuth du module mail, hors coffre, ferme a toute session.
describe('zone secrete : jetons du module mail', () => {
  let home;
  let xdg;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'guard-home-')));
    xdg = realpathSync(mkdtempSync(path.join(tmpdir(), 'guard-xdg-')));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  });
  const guardEnv = (session, payload, extra) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, ...extra };
    delete env.VAULT_MODE;
    delete env.VAULT_DOMAIN;
    if (session.mode !== undefined) env.VAULT_MODE = session.mode;
    if (session.domain !== undefined) env.VAULT_DOMAIN = session.domain;
    return spawnSync(process.execPath, [TARGET], { input: JSON.stringify({ ...payload, cwd: vault }), env, encoding: 'utf8' });
  };
  const grep = (p, glob) => ({ tool_name: 'Grep', tool_input: { pattern: 'refresh_token', path: p, ...(glob ? { glob } : {}) } });
  const SESSIONS = [{ mode: 'query', domain: 'pro' }, { mode: 'ingest', domain: 'pro' }, { mode: 'triage' }, { mode: 'setup' }];

  for (const sess of SESSIONS) {
    test(`${sess.mode} : Read, Write, Bash cat et Grep refuses, aux deux emplacements`, () => {
      for (const dir of [path.join(home, '.config', 'kioku', 'mail'), path.join(xdg, 'kioku', 'mail')]) {
        const token = path.join(dir, 'travail.json');
        const r = guardEnv(sess, read(token));
        assert.equal(r.status, REFUS, `${sess.mode} Read ${token}`);
        assert.match(r.stderr, /jetons et du client OAuth du module mail/);
        assert.equal(guardEnv(sess, read(path.join(dir, 'client.json'))).status, REFUS);
        assert.equal(guardEnv(sess, write(token)).status, REFUS, `${sess.mode} Write`);
        assert.equal(guardEnv(sess, bash(`cat ${token}`)).status, REFUS, `${sess.mode} cat absolu`);
        assert.equal(guardEnv(sess, grep(dir)).status, REFUS, `${sess.mode} Grep dans le dossier`);
      }
      for (const cmd of ['cat ~/.config/kioku/mail/travail.json', 'cat $XDG_CONFIG_HOME/kioku/mail/*.json', 'ls ~/.config/kioku', 'cat "$HOME/.config/kioku/m"*/t.json', 'type %APPDATA%\\kioku\\mail\\travail.json']) {
        assert.equal(guardEnv(sess, bash(cmd)).status, REFUS, `${sess.mode} : ${cmd}`);
      }
      assert.equal(guardEnv(sess, grep(home)).status, REFUS, `${sess.mode} : Grep depuis un parent du dossier`);
      assert.equal(guardEnv(sess, grep(path.join(home, 'ailleurs'), '**/kioku/mail/*')).status, REFUS, `${sess.mode} : motif qui vise le dossier`);
    });
  }

  test('%APPDATA% (Windows) : ferme aussi', () => {
    const appdata = path.join(home, 'Roaming');
    assert.equal(guardEnv({ mode: 'ingest', domain: 'pro' }, read(path.join(appdata, 'kioku', 'mail', 'travail.json')), { APPDATA: appdata }).status, REFUS);
  });

  test('le reste du dossier personnel n est pas touche ; kioku.mjs et bin/kioku restent nommables', () => {
    assert.equal(guardEnv({ mode: 'query', domain: 'pro' }, read(path.join(home, 'notes.txt'))).status, OK);
    assert.equal(guardEnv({ mode: 'query', domain: 'pro' }, bash('node tools/kioku.mjs doctor')).status, OK);
  });
});

// N3 et N8 : `~`, `$HOME` et les liens symboliques sont resolus avant de classer un chemin.
describe('chemins : ~, $HOME, liens symboliques', () => {
  let home;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'guard-home-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const guardHome = (session, payload, extra = {}) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, HOME: home, USERPROFILE: home, ...extra };
    delete env.VAULT_MODE;
    delete env.VAULT_DOMAIN;
    delete env.XDG_CONFIG_HOME;
    if (session.mode !== undefined) env.VAULT_MODE = session.mode;
    if (session.domain !== undefined) env.VAULT_DOMAIN = session.domain;
    return spawnSync(process.execPath, [TARGET], { input: JSON.stringify({ ...payload, cwd: vault }), env, encoding: 'utf8' }).status;
  };
  const SESSIONS = [{ mode: 'query', domain: 'pro' }, { mode: 'ingest', domain: 'pro' }, { mode: 'triage' }, { mode: 'setup' }];

  test('Read et Write `~/.config/kioku/mail/…` et `$HOME/…` : la zone secrete, refusee dans tous les modes', () => {
    for (const sess of SESSIONS) {
      for (const p of ['~/.config/kioku/mail/travail.json', '$HOME/.config/kioku/mail/client.json', '${HOME}/.config/kioku/mail/travail.json']) {
        assert.equal(guardHome(sess, read(p)), REFUS, `${sess.mode} Read ${p}`);
        assert.equal(guardHome(sess, write(p)), REFUS, `${sess.mode} Write ${p}`);
      }
    }
  });

  test('lien symbolique vers le dossier secret (dotfiles en lien) : refuse', () => {
    const real = path.join(home, 'dotfiles', 'config');
    mkdirSync(path.join(real, 'kioku', 'mail'), { recursive: true });
    symlinkSync(real, path.join(home, '.config'));
    writeFileSync(path.join(real, 'kioku', 'mail', 'travail.json'), '{}');
    // Par le lien, et par la cible reelle.
    assert.equal(guardHome({ mode: 'ingest', domain: 'pro' }, read(path.join(home, '.config', 'kioku', 'mail', 'travail.json'))), REFUS);
    assert.equal(guardHome({ mode: 'ingest', domain: 'pro' }, read(path.join(real, 'kioku', 'mail', 'travail.json'))), REFUS);
    // Un lien pose ailleurs, qui pointe sur le dossier des jetons.
    symlinkSync(path.join(real, 'kioku', 'mail'), path.join(home, 'raccourci'));
    assert.equal(guardHome({ mode: 'triage' }, read(path.join(home, 'raccourci', 'travail.json'))), REFUS);
  });

  test('lien symbolique dans le coffre vers wiki/<autre domaine> : classe comme sa cible, refuse', () => {
    mkdirSync(path.join(vault, 'wiki', 'perso'), { recursive: true });
    writeFileSync(path.join(vault, 'wiki', 'perso', 'x.md'), 'x');
    symlinkSync(path.join(vault, 'wiki', 'perso'), path.join(vault, 'notes'));
    assert.equal(guardHome({ mode: 'query', domain: 'pro' }, read('notes/x.md')), REFUS);
    assert.equal(guardHome({ mode: 'query', domain: 'pro' }, write('notes/y.md')), REFUS, 'fichier a creer : le parent existant est resolu');
  });

  test('`~/<coffre>/wiki/<autre domaine>` (coffre sous le dossier personnel) : refuse ; son propre domaine : admis', () => {
    const name = path.basename(vault);
    const parent = path.dirname(vault);
    assert.equal(guardHome({ mode: 'query', domain: 'pro' }, read(`~/${name}/wiki/perso/x.md`), { HOME: parent, USERPROFILE: parent }), REFUS);
    assert.equal(guardHome({ mode: 'query', domain: 'pro' }, read(`~/${name}/wiki/pro/x.md`), { HOME: parent, USERPROFILE: parent }), OK);
  });
});

// N1 : invariant « rien ne sort du coffre » en triage et en ingest, verifie mot par mot ; et aucune commande, dans aucun
// mode, ne peut atteindre le dossier des jetons par un glob.
describe('rien ne sort du coffre (N1)', () => {
  let home;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'guard-home-')));
    mkdirSync(path.join(home, '.config', 'kioku', 'mail'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const g = (session, command) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, HOME: home, USERPROFILE: home };
    delete env.VAULT_MODE;
    delete env.VAULT_DOMAIN;
    delete env.XDG_CONFIG_HOME;
    env.VAULT_MODE = session.mode;
    if (session.domain) env.VAULT_DOMAIN = session.domain;
    return spawnSync(process.execPath, [TARGET], { input: JSON.stringify({ ...bash(command), cwd: vault }), env, encoding: 'utf8' });
  };
  const TRIAGE = { mode: 'triage', domain: 'pro' };
  const INGEST = { mode: 'ingest', domain: 'pro' };

  test('les commandes de la contre-revue (§3 N1) : refusees', () => {
    for (const [sess, cmd] of [
      [TRIAGE, 'mv ~/.config/k*/mail/travail.json raw/pro/emails/x.md'],
      [TRIAGE, 'mv ~/.config/k*/mail/travail.json inbox/x.md'],
      [TRIAGE, 'mv ~/.conf?g/kioku/m?il/client.json raw/pro/x.md'],
      [INGEST, 'mv ~/.config/k*/mail/travail.json silver/pro/x.md'],
      [INGEST, 'mv "$HOME"/.config/"kio"ku/mail/travail.json silver/pro/x.md'],
      [{ mode: 'query', domain: 'pro' }, 'cat ~/.config/k*/mail/travail.json'],
      [{ mode: 'setup' }, 'cat ~/.config/k*/mail/travail.json'],
      [TRIAGE, 'cat ~/.config/k*/mail/travail.json'],
    ]) {
      assert.equal(g(sess, cmd).status, REFUS, `${sess.mode} : ${cmd}`);
    }
  });

  test('variantes : absolu, remontee, expansions, glob dans un dossier, options, redirections, autres commandes', () => {
    for (const sess of [TRIAGE, INGEST]) {
      for (const cmd of [
        'cp /etc/hosts inbox/',
        'mv ../x.md inbox/',
        'mv inbox/x.md ../ailleurs/',
        'cp $(echo ~)/.config/kioku/mail/t.json inbox/',
        'cp `pwd`/../x inbox/',
        "mv $'\\x7e'/.config/kioku/mail/t.json inbox/",
        'mv raw/*/x.md inbox/',
        'ln -s ~/.config inbox/lien',
        'ln -s ../../.. inbox/lien',
        'rsync -a ~/.config/ inbox/',
        'install -m 600 /tmp/x inbox/',
        'tee /tmp/sortie < inbox/x.md',
        'cat inbox/x.md > /tmp/sortie',
        'cat inbox/x.md >> ~/sortie',
        'cp --target-directory=/tmp inbox/x.md',
        'cp -t /tmp inbox/x.md',
        'cd ~/.config/kioku/mail && cp travail.json inbox/',
        'find inbox -name "*.md" -exec cp {} /tmp \;',
        'ls inbox | xargs -I{} cp inbox/{} /tmp/',
        'mv inbox/x.md C:/Users/x',
        'mv inbox/x.md \\/tmp/x',
      ]) {
        assert.equal(g(sess, cmd).status, REFUS, `${sess.mode} : ${cmd}`);
      }
    }
  });

  test('le circuit reste possible : mv relatifs a l interieur du coffre, glob en fin de chemin, /dev/null', () => {
    for (const cmd of [
      'mv inbox/2026-11-03-fil-a1b2.md raw/pro/emails/2026-11-03-fil-a1b2.md',
      'mv inbox/x.pdf inbox/x.pdf.md raw/pro/pdfs/',
      'mv "inbox/note avec espace.md" raw/pro/meetings/note-avec-espace.md',
      'mv inbox/x.md inbox/a-trancher/',
      'mv inbox/a-trancher/x.md raw/perso/meetings/',
      'mkdir -p raw/pro/emails && mv inbox/x.md raw/pro/emails/',
      'mv inbox/*.md raw/pro/meetings/',
      'mv inbox/x.md raw/pro/meetings/ 2>/dev/null',
    ]) {
      assert.equal(g(TRIAGE, cmd).status, OK, `triage : ${cmd}`);
    }
    for (const cmd of ['kioku check .candidats/wiki/pro/sources/x.md', 'kioku commit pro -m "mv et cp dans le message"', 'kioku promote .candidats/wiki/pro/sources/x.md']) {
      assert.equal(g(INGEST, cmd).status, OK, `ingest : ${cmd}`);
    }
  });

  test('un lien symbolique du coffre vers l exterieur ne sert pas de sortie', () => {
    symlinkSync(home, path.join(vault, 'dehors'));
    assert.equal(g(TRIAGE, 'mv inbox/x.md dehors/x.md').status, REFUS);
    assert.equal(g(TRIAGE, 'cp dehors/.config/kioku/mail/t.json inbox/').status, REFUS);
  });
});

