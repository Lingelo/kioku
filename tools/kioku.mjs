#!/usr/bin/env node
/**
 * kioku : creer un coffre, y ajouter un silo, prouver le cloisonnement (plan core/data, U9).
 *
 *   kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud]
 *   kioku add-domain <nom> [--preset <preset>] [--description <texte>] [--vault <dossier>]
 *   kioku doctor [--vault <dossier>]
 *   kioku check|verdict|promote|stage|audit|undecided|… <arguments>   la gate (voir hooks/vault.mjs), relayee telle quelle
 *
 * `kioku` est l'entree unique du core : `bin/kioku` sur le PATH (le plugin ajoute son bin/ au PATH des sessions ; le
 * lanceur du coffre fait de meme). Les skills appellent `kioku check <fichier>`, quel que soit l'emplacement du core.
 *
 * Deterministe, sans modele. init et add-domain n'ecrivent que des creations : rien n'est ecrase, aucun domaine
 * n'est retire ni renomme (R13 : cela se fait a la main). Ils finissent par doctor, dont l'echec fait echouer la
 * commande. Dans une session Claude Code, init et add-domain ne tournent qu'en mode setup (la garde le verifie aussi).
 *
 * doctor teste la garde DECLAREE (hook du projet dans .claude/settings.json, ou plugin kioku active), pas un chemin
 * suppose : pour chaque paire de domaines (session A, cible B), en query et en ingest, une lecture, une ecriture et une
 * commande shell vers B doivent etre refusees (code 2) ; en setup, aucun domaine ne doit se lire. Une garde absente,
 * desactivee, doublee ou qui laisse passer est signalee en premier. Avec --live, une vraie session `claude -p` tente de
 * lire un fichier absent d'un autre domaine et doit etre refusee par la garde : la seule preuve que Claude Code
 * l'execute (le hook d'un plugin ne se voit pas dans les settings du coffre).
 *
 * Codes de sortie : 0 ok ; 1 precondition ou usage (rien n'est ecrit) ; 3 cloisonnement non prouve.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_NAME, DOMAIN_ID, loadConfig } from '../hooks/config.mjs';
import { acquire, release } from './plaud-sync/lock.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = path.join(CORE, 'presets');
const TEMPLATES = path.join(CORE, 'templates');
// Les hooks du core : hooks/ dans le plugin.
const HOOKS = existsSync(path.join(CORE, 'hooks', 'guard.mjs')) ? path.join(CORE, 'hooks') : path.join(CORE, '.claude', 'hooks');
const CORE_GUARD = path.join(HOOKS, 'guard.mjs');
const GATE = path.join(HOOKS, 'vault.mjs');
// Le schema commun, importe par le CLAUDE.md du coffre (`@.kioku/schema.md`) : copie du modele du core, reecrite a
// chaque montee de version, jamais editee dans le coffre.
export const SCHEMA_REL = path.join('.kioku', 'schema.md');
/** Le schema tel que ce core le livre : noms de skills et d'agent prefixes seulement si le plugin est actif. */
export const schemaText = (env = process.env) => {
  const text = readFileSync(path.join(TEMPLATES, 'schema.md'), 'utf8');
  return env.KIOKU_PLUGIN ? text : text.replace(/\/kioku:/g, '/').replace(/`kioku:reviewer`/g, '`reviewer`');
};
// Les sous-commandes de la gate, relayees a hooks/vault.mjs avec leurs arguments, leur sortie et leur code.
export const GATE_COMMANDS = ['check', 'verdict', 'promote', 'stage', 'rotate-log', 'propose-org', 'tag-org', 'propose-raw', 'tag-raw', 'quarantine', 'undecided', 'audit', 'flag', 'decide', 'seed'];
const FOLDERS = ['sources', 'meetings', 'people', 'organizations', 'projects', 'concepts', 'decisions', 'syntheses'];
const RESERVED = new Set(['heritage']);
export const EXIT = { ok: 0, precondition: 1, isolation: 3 };

const today = () => new Date().toISOString().slice(0, 10);
const writeAtomic = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};
// Creation seulement : un fichier qui existe deja n'est jamais remplace (flag wx).
const create = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
};

/** Les presets livres : un fichier par preset sous presets/, avec une section ## Relecture. */
export const presets = () => (existsSync(PRESETS) ? readdirSync(PRESETS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : []);

const presetText = (name, domain) => {
  const file = path.join(PRESETS, `${name}.md`);
  if (!existsSync(file)) throw new Error(`preset inconnu : ${name} (livres : ${presets().join(', ')})`);
  return readFileSync(file, 'utf8').replaceAll('{{domaine}}', domain);
};

const validName = (name, existing = []) => {
  if (!DOMAIN_ID.test(name ?? '')) return `nom de domaine invalide : "${name ?? ''}" (kebab-case ASCII attendu)`;
  if (RESERVED.has(name)) return `nom de domaine reserve : ${name}`;
  if (existing.includes(name)) return `le domaine ${name} existe deja`;
  return null;
};

/** Squelette or d'un domaine : les huit dossiers (un .gitkeep), overview.md ; plus raw/ et silver/ vides. */
const skeleton = (vault, domain) => {
  for (const folder of FOLDERS) create(path.join(vault, 'wiki', domain, folder, '.gitkeep'), '');
  create(
    path.join(vault, 'wiki', domain, 'overview.md'),
    `---\ntype: overview\ntitle: "Vue d'ensemble — ${domain}"\ncreated: ${today()}\nupdated: ${today()}\nstatus: draft\n---\n\n# Vue d'ensemble\n\n> Synthèse narrative vivante. Première synthèse à écrire quand ce domaine aura assez de pages.\n`,
  );
  create(path.join(vault, 'raw', domain, '.gitkeep'), '');
  create(path.join(vault, 'silver', domain, '.gitkeep'), '');
};

/** Hors session Claude (terminal) : permis. En session : seulement en mode setup. */
const sessionRefusal = (env) => {
  if (!env.CLAUDECODE && env.VAULT_MODE === undefined) return null;
  return env.VAULT_MODE === 'setup' ? null : `session ${env.VAULT_MODE ?? '(sans mode)'} : configurer le coffre se fait en session setup (node tools/vault.mjs --mode setup) ou depuis un terminal`;
};

// ---------------------------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------------------------

/** Les settings qui s'appliquent au coffre : projet, local, et utilisateur (un plugin s'active souvent la). */
const readSettings = (vault, home = process.env.HOME) => {
  const files = [path.join(vault, '.claude', 'settings.json'), path.join(vault, '.claude', 'settings.local.json')];
  if (home) files.push(path.join(home, '.claude', 'settings.json'));
  return files
    .filter((f) => existsSync(f))
    .map((f) => {
      try {
        return { file: f, data: JSON.parse(readFileSync(f, 'utf8')) };
      } catch {
        return { file: f, data: null };
      }
    });
};

/** Le plugin kioku est-il active (`enabledPlugins` : `kioku@<marketplace>`: true) dans l'un des settings ? */
export const kiokuPluginEnabled = (settings) =>
  settings.some(({ data }) => Object.entries(data?.enabledPlugins ?? {}).some(([id, on]) => on === true && /^kioku@/.test(id)));

/**
 * La garde qui protege le coffre, telle que les settings la declarent : un hook PreToolUse du projet, ou le plugin
 * kioku active. Rend { guard, source, why, double }.
 *   guard   le script a sonder (le hook du projet, ou la garde de ce core pour le plugin)
 *   source  'projet' | 'plugin'
 *   double  vrai si le hook du projet ET le plugin sont actifs : deux gardes de versions possiblement differentes.
 * Cette lecture est statique : elle dit ce qui est DECLARE. Seule la sonde reelle (--live) prouve que Claude Code
 * execute la garde.
 */
export const registeredGuard = (vault, { home } = {}) => {
  const settings = readSettings(vault, home);
  const broken = settings.find((s) => s.data === null);
  if (broken) return { guard: null, why: `settings illisibles : ${broken.file}` };
  if (settings.some((s) => s.data.disableAllHooks === true)) return { guard: null, why: 'disableAllHooks est actif : aucun hook ne tourne' };
  const plugin = kiokuPluginEnabled(settings);
  const needed = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];
  // Le hook du projet : seulement dans les settings du coffre, pas dans ceux de l'utilisateur (ils valent partout).
  for (const { file, data } of settings.filter((s) => s.file.startsWith(path.join(vault, '.claude')))) {
    for (const entry of data.hooks?.PreToolUse ?? []) {
      const matcher = String(entry.matcher ?? '');
      for (const h of entry.hooks ?? []) {
        const m = String(h.command ?? '').match(/node\s+"?([^"]*guard\.mjs)"?/);
        if (!m) continue;
        const missing = needed.filter((t) => !new RegExp(`(^|\\|)${t}(\\||$)`).test(matcher));
        if (missing.length) return { guard: null, why: `le hook de garde ne couvre pas ${missing.join(', ')} (matcher "${matcher}", ${path.relative(vault, file)})` };
        const script = m[1].replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, vault);
        if (!existsSync(script)) return { guard: null, why: `garde enregistree introuvable : ${script}` };
        return { guard: script, source: 'projet', why: null, double: plugin };
      }
    }
  }
  if (plugin) return { guard: CORE_GUARD, source: 'plugin', why: null, double: false };
  return { guard: null, why: 'ni hook PreToolUse de garde dans .claude/settings.json, ni plugin kioku active (enabledPlugins)' };
};

// ---------------------------------------------------------------------------------------------------------------
// sonde reelle (--live)
// ---------------------------------------------------------------------------------------------------------------

/** Le fichier vise par la sonde : dans un autre domaine, et absent. Une garde en panne ne livre donc aucun contenu. */
export const PROBE_FILE = '.kioku-sonde-absente.md';

/**
 * Lit les evenements stream-json d'une session sonde. Rend { refused, attempted, plugins, why }.
 * Refus prouve : un appel Read sur le fichier sonde, et son resultat en erreur portant la signature de la garde
 * (« hook error » et « Session query/ »). Un refus d'une autre nature (fichier absent, permission) ne compte pas :
 * c'est justement ce qu'on verrait si la garde ne tournait pas.
 */
export const readProbe = (stdout, target) => {
  const events = String(stdout)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const plugins = (init?.plugins ?? []).map((p) => p?.name ?? p);
  const ids = new Set();
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'Read' && String(c.input?.file_path ?? '').endsWith(target)) ids.add(c.id);
    }
  }
  if (!ids.size) return { refused: false, attempted: false, plugins, why: "la session n'a pas tente la lecture : sonde non concluante" };
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_result' || !ids.has(c.tool_use_id)) continue;
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      if (c.is_error && /hook error/i.test(text) && /Session query\//.test(text)) return { refused: true, attempted: true, plugins, why: null };
      return { refused: false, attempted: true, plugins, why: c.is_error ? `lecture refusee, mais pas par la garde : ${text.slice(0, 160)}` : 'la lecture a abouti : la garde ne l a pas refusee' };
    }
  }
  return { refused: false, attempted: true, plugins, why: 'aucun resultat pour la lecture tentee : sonde non concluante' };
};

/** Une vraie session `claude -p`, ouverte en query sur un domaine, tente de lire un fichier absent d'un autre domaine. */
export const liveProbe = (vault, domains, { claude = process.env.KIOKU_CLAUDE || 'claude', pluginDir, timeout = 240_000 } = {}) => {
  if (domains.length < 2) return { refused: true, attempted: false, plugins: [], why: null, skipped: 'un seul domaine : rien a cloisonner' };
  const [a, b] = domains;
  const target = path.join('wiki', b, PROBE_FILE);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: 'query', VAULT_DOMAIN: a, PATH: [path.join(CORE, 'bin'), process.env.PATH].join(path.delimiter) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const prompt =
    `Controle de cloisonnement demande par le proprietaire du coffre (sonde de kioku doctor). ` +
    `Appelle l'outil Read, une seule fois, sur ce chemin exact : ${target}. Ne fais rien d'autre, puis reponds en un mot.`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--allowedTools', 'Read'];
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  const r = spawnSync(claude, args, { cwd: vault, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { refused: false, attempted: false, plugins: [], why: `impossible de lancer claude : ${r.error.message}` };
  return readProbe(r.stdout, target);
};

/** Lance la garde comme Claude Code : entree JSON sur stdin, mode et domaine dans l'environnement. Rend le code. */
const probe = (guard, vault, session, payload) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: vault };
  delete env.VAULT_MODE;
  delete env.VAULT_DOMAIN;
  delete env.CLAUDECODE;
  if (session.mode) env.VAULT_MODE = session.mode;
  if (session.domain) env.VAULT_DOMAIN = session.domain;
  return spawnSync(process.execPath, [guard], { input: JSON.stringify({ ...payload, cwd: vault }), env, encoding: 'utf8' }).status;
};
const read = (p) => ({ tool_name: 'Read', tool_input: { file_path: p } });
const write = (p) => ({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' } });
const bash = (c) => ({ tool_name: 'Bash', tool_input: { command: c } });

/**
 * La matrice de refus (KTD8) : rend { leaks, closed, checks }. `leaks` : acces a un autre domaine que la garde
 * laisse passer (cloisonnement rompu). `closed` : acces au domaine de la session refuse (garde fermee a tort).
 */
export const isolationMatrix = (guard, vault, domains) => {
  const leaks = [];
  const closed = [];
  let checks = 0;
  const expect = (want, session, payload, label) => {
    checks++;
    const got = probe(guard, vault, session, payload);
    if (want === 2 && got !== 2) leaks.push(`${label} (code ${got})`);
    if (want === 0 && got !== 0) closed.push(`${label} (code ${got})`);
  };
  for (const a of domains) {
    for (const mode of ['query', 'ingest']) {
      const s = { mode, domain: a };
      expect(0, s, read(`wiki/${a}/index.md`), `${mode}/${a} lit son wiki`);
      for (const b of domains.filter((d) => d !== a)) {
        expect(2, s, read(`wiki/${b}/index.md`), `${mode}/${a} lit wiki/${b}`);
        expect(2, s, read(`raw/${b}/x.md`), `${mode}/${a} lit raw/${b}`);
        expect(2, s, read(`domains/${b}/rules.md`), `${mode}/${a} lit domains/${b}`);
        expect(2, s, write(`.candidats/wiki/${b}/concepts/x.md`), `${mode}/${a} ecrit dans .candidats/wiki/${b}`);
        expect(2, s, bash(`cat wiki/${b}/index.md`), `${mode}/${a} lit wiki/${b} par le shell`);
      }
    }
    expect(2, { mode: 'setup' }, read(`wiki/${a}/index.md`), `setup lit wiki/${a}`);
    expect(2, { mode: 'setup' }, read(`domains/${a}/rules.md`), `setup lit domains/${a}`);
  }
  expect(2, { mode: 'query', domain: domains[0] }, write(CONFIG_NAME), 'une session ecrit la configuration');
  return { leaks, closed, checks };
};

/**
 * Diagnostic complet. Rend { code, lines }. Le cloisonnement est rapporte en premier.
 * `live` : en plus de la matrice sur le script, une vraie session prouve que Claude Code execute la garde.
 */
export const doctor = (vault, { live = false, pluginDir, home } = {}) => {
  const isolation = [];
  const problems = [];
  const notes = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) problems.push(`Node ${process.versions.node} : 20 ou plus requis`);
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) problems.push('git introuvable');
  if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) notes.push('claude introuvable sur ce poste : les sessions ne pourront pas s\'ouvrir');

  let cfg;
  try {
    cfg = loadConfig(vault);
  } catch (error) {
    return { code: EXIT.precondition, lines: [`ECHEC  ${error.message}`] };
  }
  for (const d of cfg.domains) {
    if (!existsSync(path.join(vault, 'wiki', d))) problems.push(`wiki/${d}/ absent (squelette : node tools/plaud-sync/run.mjs --init-structure, ou add-domain)`);
    const rules = cfg.rulesPath(d);
    if (!existsSync(rules)) problems.push(`domains/${d}/rules.md absent : le relecteur ne juge rien dans ce domaine`);
    else if (!/^## Relecture$/m.test(readFileSync(rules, 'utf8'))) problems.push(`domains/${d}/rules.md sans section ## Relecture`);
  }

  const { guard, source, why, double } = registeredGuard(vault, { home });

  // Le schema attendu suit la garde declaree : noms prefixes avec le plugin, nus avec un hook du projet.
  const schema = path.join(vault, SCHEMA_REL);
  const expected = schemaText(source === 'plugin' || pluginDir ? { KIOKU_PLUGIN: 'kioku' } : {});
  if (!existsSync(schema)) problems.push(`${SCHEMA_REL} absent : les sessions n'ont pas le schema commun (CLAUDE.md l'importe)`);
  else if (readFileSync(schema, 'utf8') !== expected) notes.push(`${SCHEMA_REL} differe du schema de ce core : version differente, ou modifie a la main`);

  if (!guard && !pluginDir) isolation.push(`garde non branchee : ${why}`);
  else {
    const script = guard ?? CORE_GUARD;
    const m = isolationMatrix(script, vault, cfg.domains);
    for (const l of m.leaks) isolation.push(`la garde laisse passer : ${l}`);
    for (const c of m.closed) problems.push(`la garde refuse a tort : ${c}`);
    notes.push(`garde (${source ?? 'plugin --plugin-dir'}) : ${script} — ${m.checks} sondes, ${cfg.domains.length} domaine(s)`);
    if (source === 'plugin') notes.push('garde du plugin : la matrice sonde le script de ce core ; seule la sonde reelle (--live) prouve celui que Claude Code charge');
  }
  if (double) problems.push('double garde : un hook de garde dans .claude/settings.json ET le plugin kioku actif ; retire le hook du projet (une seule garde, une seule version)');

  if (live) {
    const p = liveProbe(vault, cfg.domains, { pluginDir });
    if (p.skipped) notes.push(`sonde reelle : ${p.skipped}`);
    else if (p.refused) notes.push(`sonde reelle : une session ${cfg.domains[0]} est refusee par la garde sur ${cfg.domains[1]}`);
    else isolation.unshift(`sonde reelle : ${p.why}`);
    // Plugin active (ou force par --plugin-dir) mais absent de la session : la garde du plugin ne tourne pas.
    const expectPlugin = source === 'plugin' || Boolean(pluginDir);
    if (expectPlugin && !p.skipped && !p.plugins.includes('kioku')) isolation.unshift('sonde reelle : le plugin kioku est active mais absent de la session (non installe, ou pas encore approuve)');
  } else {
    notes.push('sonde reelle non lancee : kioku doctor --live ouvre une vraie session pour prouver que Claude Code execute la garde');
  }

  const lines = [];
  for (const i of isolation) lines.push(`CLOISONNEMENT  ${i}`);
  for (const p of problems) lines.push(`ECHEC  ${p}`);
  for (const n of notes) lines.push(`note   ${n}`);
  const code = isolation.length ? EXIT.isolation : problems.length ? EXIT.precondition : EXIT.ok;
  lines.unshift(code === EXIT.ok ? 'doctor : cloisonnement prouve' : code === EXIT.isolation ? 'doctor : CLOISONNEMENT NON PROUVE' : 'doctor : a corriger');
  return { code, lines };
};

// ---------------------------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------------------------

export const init = (target, { domains = ['pro', 'perso'], org = null, plaud = false } = {}) => {
  const vault = path.resolve(target);
  if (path.relative(CORE, vault) === '' ) return { code: EXIT.precondition, lines: ['init : refuse sur le core lui-meme'] };
  if (existsSync(vault) && readdirSync(vault).length) return { code: EXIT.precondition, lines: [`init : ${vault} n'est pas vide, rien n'est ecrit`] };
  const seen = [];
  for (const d of domains) {
    const bad = validName(d, seen);
    if (bad) return { code: EXIT.precondition, lines: [`init : ${bad}`] };
    seen.push(d);
  }
  if (org && !domains.includes(org)) return { code: EXIT.precondition, lines: [`init : --org ${org} n'est pas un des domaines (${domains.join(', ')})`] };
  const known = presets();
  for (const d of domains) if (!known.includes(d) && !known.includes('minimal')) return { code: EXIT.precondition, lines: [`init : aucun preset pour ${d}`] };

  mkdirSync(vault, { recursive: true });
  const config = {
    version: 1,
    domains: domains.map((id) => (id === org ? { id, extensions: { org: { registry: 'orgs.json' } } } : { id })),
    ...(plaud ? { modules: { plaud: { state: 'tools/plaud-sync' } } } : {}),
  };
  writeAtomic(path.join(vault, CONFIG_NAME), `${JSON.stringify(config, null, 2)}\n`);
  for (const d of domains) {
    skeleton(vault, d);
    create(path.join(vault, 'domains', d, 'rules.md'), presetText(known.includes(d) ? d : 'minimal', d));
  }
  if (org) {
    create(
      path.join(vault, 'orgs.json'),
      `${JSON.stringify({ employer: 'employeur', orgs: [{ id: 'employeur', name: 'Employeur (a renommer)', role: 'employer' }], org_required: true }, null, 2)}\n`,
    );
  }
  // Repli de la phase B (KTD2) : le hook vise la garde du core par chemin absolu ; le plugin la remplacera (U11).
  create(
    path.join(vault, '.claude', 'settings.json'),
    `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead|Bash', hooks: [{ type: 'command', command: `node "${CORE_GUARD}"` }] }] } }, null, 2)}\n`,
  );
  create(path.join(vault, SCHEMA_REL), schemaText());
  create(path.join(vault, 'CLAUDE.md'), readFileSync(path.join(TEMPLATES, 'vault-CLAUDE.md'), 'utf8'));
  create(path.join(vault, '.gitignore'), `# Jamais versionne : l'entrant (pas encore classe)\ninbox/\n.env\n.env.*\n${plaud ? 'tools/plaud-sync/.snapshot.json\ntools/plaud-sync/.queue.json\ntools/plaud-sync/.lock.json\n' : ''}`);
  mkdirSync(path.join(vault, 'inbox'), { recursive: true });

  const d = doctor(vault);
  return { code: d.code, lines: [`init : coffre cree dans ${vault} (${domains.join(', ')})`, ...(org ? [`registre a remplir : ${path.join(vault, 'orgs.json')}`] : []), ...d.lines] };
};

// ---------------------------------------------------------------------------------------------------------------
// add-domain
// ---------------------------------------------------------------------------------------------------------------

export const addDomain = (vaultDir, name, { preset = 'minimal', description } = {}) => {
  const vault = path.resolve(vaultDir);
  let cfg;
  try {
    cfg = loadConfig(vault);
  } catch (error) {
    return { code: EXIT.precondition, lines: [`add-domain : ${error.message}`] };
  }
  const bad = validName(name, cfg.domains);
  if (bad) return { code: EXIT.precondition, lines: [`add-domain : ${bad}`] };
  if (!presets().includes(preset)) return { code: EXIT.precondition, lines: [`add-domain : preset inconnu : ${preset} (livres : ${presets().join(', ')})`] };
  // Rien de ce domaine ne doit exister : un dossier orphelin (domaine retire a la main) n'est pas reutilise en silence.
  const leftovers = ['wiki', 'raw', 'silver', 'quarantine', 'domains'].map((z) => path.join(z, name)).filter((rel) => existsSync(path.join(vault, rel)));
  if (leftovers.length) return { code: EXIT.precondition, lines: [`add-domain : deja present sur le disque, rien n'est ecrit : ${leftovers.join(', ')}`] };

  const lock = acquire(vault);
  if (!lock.ok) return { code: EXIT.precondition, lines: [`add-domain : le circuit Plaud tourne (PID ${lock.held?.pid}), relance apres`] };
  try {
    skeleton(vault, name);
    create(path.join(vault, 'domains', name, 'rules.md'), presetText(preset, name));
    // La configuration en dernier : tant qu'elle ne declare pas le domaine, la garde le tient ferme.
    const raw = JSON.parse(readFileSync(path.join(vault, CONFIG_NAME), 'utf8'));
    raw.domains.push(description ? { id: name, description } : { id: name });
    writeAtomic(path.join(vault, CONFIG_NAME), `${JSON.stringify(raw, null, 2)}\n`);
  } finally {
    release(vault);
  }
  const d = doctor(vault);
  const head = d.code === EXIT.isolation ? `add-domain : ${name} cree, MAIS le cloisonnement n'est pas prouve : ne t'en sers pas avant de corriger` : `add-domain : ${name} cree (preset ${preset})`;
  return { code: d.code, lines: [head, ...d.lines] };
};

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = [
  'usage :',
  '  kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud]',
  '  kioku add-domain <nom> [--preset <preset>] [--description <texte>] [--vault <dossier>]',
  '  kioku doctor [--live] [--plugin-dir <core>] [--vault <dossier>]   (--live : sonde par une vraie session claude -p)',
  `  kioku ${GATE_COMMANDS.join('|')} <arguments>   (la gate)`,
  'Retirer ou renommer un domaine ne passe pas par ce CLI : a la main, hors session (configuration, dossiers, regles),',
  'puis kioku doctor.',
].join('\n');

const main = (argv, env) => {
  const [cmd, ...rest] = argv;
  const opt = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  const vault = path.resolve(opt('--vault') ?? env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (cmd === 'doctor') return doctor(vault, { live: rest.includes('--live'), pluginDir: opt('--plugin-dir') });
  if (cmd === 'init' || cmd === 'add-domain') {
    const refusal = sessionRefusal(env);
    if (refusal) return { code: EXIT.precondition, lines: [`${cmd} : ${refusal}`] };
  }
  if (cmd === 'init') {
    if (!positional[0]) return { code: EXIT.precondition, lines: [USAGE] };
    const domains = (opt('--domains') ?? 'pro,perso').split(',').map((s) => s.trim()).filter(Boolean);
    return init(positional[0], { domains, org: opt('--org') ?? null, plaud: rest.includes('--plaud') });
  }
  if (cmd === 'add-domain') {
    if (!positional[0]) return { code: EXIT.precondition, lines: [USAGE] };
    return addDomain(vault, positional[0], { preset: opt('--preset') ?? 'minimal', description: opt('--description') });
  }
  return { code: EXIT.precondition, lines: [USAGE] };
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect && GATE_COMMANDS.includes(process.argv[2])) {
  // La gate garde sa sortie et son code (0, 1, 3, 4) : relais transparent, meme repertoire, meme environnement.
  const r = spawnSync(process.execPath, [GATE, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (isDirect) {
  let out;
  try {
    out = main(process.argv.slice(2), process.env);
  } catch (error) {
    out = { code: EXIT.precondition, lines: [`kioku : ${error instanceof Error ? error.message : String(error)}`] };
  }
  console.log(out.lines.join('\n'));
  process.exit(out.code);
}
