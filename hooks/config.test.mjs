/**
 * Tests de la configuration du coffre (plan core/data, U2, U3).
 * `node --test hooks/config.test.mjs`
 * Coffre factice dans un dossier temporaire, domaines fictifs : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { loadConfig } from './config.mjs';

let vault;
beforeEach(() => {
  vault = realpathSync(mkdtempSync(path.join(tmpdir(), 'vault-config-test-')));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const put = (data) => writeFileSync(path.join(vault, 'kioku.config.json'), typeof data === 'string' ? data : JSON.stringify(data));
const domains = (...list) => ({ version: 1, domains: list });
const fails = (pattern) => assert.throws(() => loadConfig(vault), pattern);

describe('configuration valide', () => {
  test('deux domaines, extension org sur le premier seulement', () => {
    put(domains({ id: 'travail', extensions: { org: { registry: 'orgs.json' } } }, { id: 'maison' }));
    const c = loadConfig(vault);
    assert.deepEqual(c.domains, ['travail', 'maison']);
    assert.equal(c.orgRegistry('travail'), path.join(vault, 'orgs.json'));
    assert.equal(c.orgRegistry('maison'), null);
  });

  test('trois domaines : liste dans l ordre declare, others exclut le domaine courant', () => {
    put(domains({ id: 'a' }, { id: 'b' }, { id: 'c' }));
    const c = loadConfig(vault);
    assert.deepEqual(c.domains, ['a', 'b', 'c']);
    assert.deepEqual(c.others('b'), ['a', 'c']);
    assert.ok(c.has('c'));
    assert.ok(!c.has('d'));
  });

  test('regles par convention : domains/<D>/rules.md', () => {
    put(domains({ id: 'a' }));
    assert.equal(loadConfig(vault).rulesPath('a'), path.join(vault, 'domains', 'a', 'rules.md'));
  });

  test('domaine non declare : erreur qui liste les domaines', () => {
    put(domains({ id: 'a' }, { id: 'b' }));
    const c = loadConfig(vault);
    assert.throws(() => c.rulesPath('z'), /non declare : "z".*a, b/);
    assert.throws(() => c.orgRegistry('z'), /non declare/);
  });

  test('modules et core optionnels', () => {
    put({ ...domains({ id: 'a' }), modules: { plaud: { state: 'etat/plaud' }, dashboard: {} }, core: '/opt/kioku' });
    const c = loadConfig(vault);
    assert.equal(c.modules.plaud.state, 'etat/plaud');
    assert.equal(c.core, '/opt/kioku');
  });

  test('registre declare mais absent : la config se charge (le registre se juge a part)', () => {
    put(domains({ id: 'a', extensions: { org: { registry: 'absent.json' } } }));
    assert.equal(loadConfig(vault).orgRegistry('a'), path.join(vault, 'absent.json'));
  });

  test('default_session absent : null ; present : rendu tel quel', () => {
    put(domains({ id: 'a' }));
    assert.equal(loadConfig(vault).defaultSession, null);
    put({ ...domains({ id: 'a' }), default_session: { mode: 'query', domain: 'a' } });
    assert.deepEqual(loadConfig(vault).defaultSession, { mode: 'query', domain: 'a' });
  });

  test('chemins proteges : la configuration et chaque registre declare', () => {
    put(domains({ id: 'a', extensions: { org: { registry: 'etat/orgs.json' } } }, { id: 'b' }));
    assert.deepEqual(loadConfig(vault).protectedPaths, [path.join(vault, 'kioku.config.json'), path.join(vault, 'etat/orgs.json')]);
  });
});

describe('configuration refusee, probleme nomme', () => {
  test('absente', () => fails(/absente : kioku\.config\.json/));
  test('JSON illisible', () => {
    put('{ pas du json');
    fails(/illisible/);
  });
  test('version manquante ou autre', () => {
    put({ domains: [{ id: 'a' }] });
    fails(/"version" doit valoir 1/);
  });
  test('liste de domaines absente ou vide', () => {
    put({ version: 1 });
    fails(/"domains" doit etre une liste/);
    put(domains());
    fails(/ne peut pas etre vide/);
  });
  test('domaine en double', () => {
    put(domains({ id: 'a' }, { id: 'a' }));
    fails(/en double : a/);
  });
  test('identifiant non kebab-case', () => {
    for (const id of ['Pro', 'a_b', 'a/b', '../x', '', 'a--b']) {
      put(domains({ id }));
      fails(/identifiant de domaine invalide/);
    }
  });
  test('identifiant reserve', () => {
    put(domains({ id: 'heritage' }));
    fails(/reserve : heritage/);
  });
  test('extension inconnue (faute de frappe) : refusee, pas ignoree', () => {
    put(domains({ id: 'a', extensions: { orgs: { registry: 'x.json' } } }));
    fails(/extension inconnue "orgs"/);
  });
  test('registre hors du coffre ou absolu', () => {
    for (const registry of ['../x.json', '/etc/x.json', '', undefined]) {
      put(domains({ id: 'a', extensions: { org: { registry } } }));
      fails(/"registry" doit etre un chemin relatif au coffre/);
    }
  });
  test('module inconnu, etat Plaud hors du coffre', () => {
    put({ ...domains({ id: 'a' }), modules: { slack: {} } });
    fails(/module inconnu "slack"/);
    put({ ...domains({ id: 'a' }), modules: { plaud: { state: '../x' } } });
    fails(/module plaud/);
  });
  test('default_session : mode inconnu ou domaine non declare', () => {
    put({ ...domains({ id: 'a' }), default_session: { mode: 'tout', domain: 'a' } });
    fails(/default_session\.mode/);
    put({ ...domains({ id: 'a' }), default_session: { mode: 'query', domain: 'z' } });
    fails(/default_session\.domain/);
    put({ ...domains({ id: 'a' }), default_session: { mode: 'query' } });
    fails(/default_session\.domain/);
  });
  test('plusieurs problemes : tous nommes en une fois', () => {
    put(domains({ id: 'a' }, { id: 'a' }, { id: 'B' }));
    fails(/en double : a.*invalide : "B"/);
  });
});

describe('module mail', () => {
  const base = (mail, extraDomains = []) => ({
    version: 1,
    domains: [{ id: 'pro', extensions: { org: { registry: 'orgs.json' } } }, { id: 'perso' }, ...extraDomains],
    modules: { mail },
  });
  const registry = () => writeFileSync(path.join(vault, 'orgs.json'), JSON.stringify({ employer: 'acme', orgs: [{ id: 'acme', name: 'Acme', role: 'employer' }, { id: 'globex', name: 'Globex', role: 'client', status: 'active' }], org_required: false }));
  const account = (extra = {}) => ({ id: 'travail', provider: 'gmail', label: 'kb', ...extra });

  test('comptes vides, puis un compte complet avec hint domaine et organisation du registre : admis', () => {
    put(base({ state: 'tools/mail-sync', accounts: [] }));
    assert.deepEqual(loadConfig(vault).modules.mail.accounts, []);
    registry();
    put(base({ state: 'tools/mail-sync', accounts: [account({ hint: { domain: 'pro', org: 'globex' } }), { id: 'maison', provider: 'gmail' }], max_pdf_mb: 10 }));
    assert.equal(loadConfig(vault).modules.mail.accounts.length, 2);
  });

  test('hint.domain hors des domaines declares : refuse', () => {
    put(base({ state: 'tools/mail-sync', accounts: [account({ hint: { domain: 'club' } })] }));
    fails(/compte travail, hint\.domain "club" n'est pas un domaine declare/);
  });

  test('hint.org absent du registre, ou sans domaine a extension org : refuse', () => {
    registry();
    put(base({ state: 'tools/mail-sync', accounts: [account({ hint: { domain: 'pro', org: 'initech' } })] }));
    fails(/hint\.org "initech" absent du registre orgs\.json/);
    put(base({ state: 'tools/mail-sync', accounts: [account({ hint: { domain: 'perso', org: 'acme' } })] }));
    fails(/hint\.org exige un hint\.domain a extension org/);
  });

  test('registre illisible : la configuration reste chargeable (la garde en depend), le registre a son propre message', () => {
    writeFileSync(path.join(vault, 'orgs.json'), '{ tronque');
    put(base({ state: 'tools/mail-sync', accounts: [account({ hint: { domain: 'pro', org: 'acme' } })] }));
    assert.doesNotThrow(() => loadConfig(vault));
  });

  test('identifiant invalide ou en double, fournisseur inconnu, label vide, cle de hint inconnue, etat hors coffre', () => {
    put(base({ state: '../x', accounts: [account({ id: 'Travail' }), account(), account(), account({ id: 'b', provider: 'imap', label: ' ' }), account({ id: 'c', hint: { domaine: 'pro' } })], max_pdf_mb: 0 }));
    fails(/"state" doit valoir "tools\/mail-sync".*max_pdf_mb.*identifiant de compte invalide "Travail".*compte en double travail.*compte b, fournisseur inconnu "imap".*compte b, "label".*cle de hint inconnue "domaine"/);
  });

  test('state autre que tools/mail-sync : refuse (il serait ignore, m1)', () => {
    put(base({ state: 'etat/mail', accounts: [] }));
    fails(/"state" doit valoir "tools\/mail-sync"/);
  });

  test('accounts absent : refuse (liste vide pour commencer)', () => {
    put(base({ state: 'tools/mail-sync' }));
    fails(/"accounts" doit etre une liste/);
  });
});
