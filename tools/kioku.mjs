#!/usr/bin/env node
/**
 * kioku : creer un coffre, y ajouter un silo, prouver le cloisonnement (plan core/data, U9).
 *
 *   kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud] [--guard-hook]
 *   kioku add-domain <nom> [--preset <preset>] [--description <texte>] [--vault <dossier>]
 *   kioku doctor [--vault <dossier>]
 *   kioku upgrade [--write] [--vault <dossier>]   amene un coffre existant a la forme courante d'init (simulation par defaut)
 *   kioku session|dashboard|plaud …   les outils du core (lanceur, dashboard, Plaud), relayes tels quels (voir toolCommand)
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
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_NAME, DOMAIN_ID, loadConfig, locateVault, vaultMarkers } from '../hooks/config.mjs';
import { appendTopLevelKeys, gitignoreBlock, INSTALL_HINT, localDenyRules, managedScripts, mergeConfig, mergeDenyRules, mergeGitignore, mergeScripts, mergeSettings, PLUGIN_ID, VAULT_FORMAT } from './managed.mjs';
import { formatRefusal } from './plugin-install.mjs';
import { acquire, holderText, release } from './connectors/lock.mjs';

export { PLUGIN_ID };

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
export const GATE_COMMANDS = ['commit', 'check', 'verdict', 'promote', 'stage', 'rotate-log', 'propose-org', 'tag-org', 'propose-raw', 'tag-raw', 'quarantine', 'undecided', 'audit', 'flag', 'decide', 'seed'];
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

/** Le dossier lui-meme s'il existe, sinon son premier parent existant. */
const existingDir = (dir) => {
  let d = path.resolve(dir);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
};

/** Hors session Claude (terminal) : permis. En session : seulement en mode setup (ou init hors coffre, voir plus bas). */
const sessionRefusal = (env, { initTarget } = {}) => {
  if (!env.CLAUDECODE && env.VAULT_MODE === undefined) return null;
  // /kioku:setup create : une session ouverte dans un dossier qui n'est pas un coffre n'a pas de VAULT_MODE (aucun
  // coffre ne le pose) et la garde ne s'y applique pas (chantier 1). init y est permis, et seulement la : meme regle
  // que la garde (locateVault), evaluee sur la cible ou, si elle n'existe pas encore, sur son premier parent existant.
  if (initTarget && env.VAULT_MODE === undefined && env.VAULT_DOMAIN === undefined && locateVault(existingDir(initTarget)) === 'none') return null;
  return env.VAULT_MODE === 'setup' ? null : `session ${env.VAULT_MODE ?? '(sans mode)'} : configurer le coffre se fait depuis un terminal hors de Claude Code, ou en session setup (npm run setup, ou kioku session --mode setup)`;
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

/**
 * Le hook de garde : `<interpreteur> "<...>/guard.mjs"`, l'interpreteur nu (`node`, coffres anterieurs) ou par chemin
 * absolu entre guillemets (init --guard-hook : process.execPath). Groupes : 1 ou 2 l'interpreteur, 3 le script.
 */
const HOOK_COMMAND = /(?:^|[\s;&|(])(?:"([^"]*node(?:\.exe)?)"|([^\s"';&|()]*node(?:\.exe)?))\s+"?([^"]*guard\.mjs)"?/;
// Un hook dont l'interpreteur manque sort en 127, que Claude Code traite comme non bloquant : la session tournerait sans
// garde. `|| exit 2` ferme ce cas (et tout echec du script) en refus.
const FAIL_CLOSED = /\|\|\s*exit\s+2(?![\w])/;
export const GUARD_HOOK_COMMAND = (guard, interpreter = process.execPath) => `"${interpreter}" "${guard}" || exit 2`;

const isExecutableFile = (file) => {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};
/** L'interpreteur du hook se resout-il : chemin -> fichier executable ; nom nu -> trouve dans le PATH donne. */
export const interpreterResolves = (cmd, searchPath = process.env.PATH ?? '') => {
  if (typeof cmd !== 'string' || cmd === '') return false;
  if (/[/\\]/.test(cmd)) return isExecutableFile(cmd);
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : [''];
  return searchPath.split(path.delimiter).filter(Boolean).some((dir) => exts.some((e) => isExecutableFile(path.join(dir, cmd + e))));
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
        const command = String(h.command ?? '');
        const m = command.match(HOOK_COMMAND);
        if (!m) continue;
        const missing = needed.filter((t) => !new RegExp(`(^|\\|)${t}(\\||$)`).test(matcher));
        if (missing.length) return { guard: null, why: `le hook de garde ne couvre pas ${missing.join(', ')} (matcher "${matcher}", ${path.relative(vault, file)})` };
        const script = m[3].replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, vault);
        if (!existsSync(script)) return { guard: null, why: `garde enregistree introuvable : ${script}` };
        const interpreter = m[1] ?? m[2];
        if (!interpreterResolves(interpreter)) return { guard: null, why: `interpreteur du hook de garde introuvable : ${interpreter} (${path.relative(vault, file)}) ; Claude Code traiterait l'echec du hook comme non bloquant` };
        return { guard: script, source: 'projet', why: null, double: plugin, failOpen: !FAIL_CLOSED.test(command) };
      }
    }
  }
  if (plugin) {
    // Le hook du plugin (hooks/hooks.json) lance `node` par le PATH : il ne peut pas porter le chemin de l'interpreteur
    // d'une autre machine. Une session ouverte par le lanceur herite de ce PATH ; une session ouverte ailleurs (app de
    // bureau, autre terminal) peut en avoir un autre : le hook s'y ferme alors (`|| exit 2`), voir le guide 10.
    if (!interpreterResolves('node')) return { guard: null, why: "node introuvable dans le PATH : le hook du plugin (node \"…/guard.mjs\") ne pourrait pas lancer la garde" };
    return { guard: CORE_GUARD, source: 'plugin', why: null, double: false };
  }
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
    // Configuration absente : la garde ne refuse que dans un coffre abime ; hors coffre, elle ne s'applique pas.
    const markers = existsSync(path.join(vault, CONFIG_NAME)) ? [] : vaultMarkers(vault);
    // Sous-dossier d'un coffre sain : la racine est chez un parent, rien n'est abime.
    const parentConfig = markers.find((m) => path.basename(m) === CONFIG_NAME);
    if (parentConfig) {
      const rootDir = path.dirname(parentConfig);
      return {
        code: EXIT.precondition,
        lines: [`ECHEC  ${vault} est un sous-dossier du coffre ${rootDir} : ouvre la racine du coffre (cd ${rootDir}, ou --vault ${rootDir})`, 'note   la garde refuse une session ouverte dans un sous-dossier : elle ne se rabat pas sur une autre racine'],
      };
    }
    if (markers.length) {
      return {
        code: EXIT.precondition,
        lines: [
          `ECHEC  coffre abime : ${CONFIG_NAME} absent, mais ${markers.join(', ')} present(s)`,
          'note   la garde refuse tout dans ce dossier tant que la configuration manque : restaure-la (git checkout, sauvegarde) ; init refuse un dossier non vide',
        ],
      };
    }
    if (!existsSync(path.join(vault, CONFIG_NAME))) {
      return { code: EXIT.precondition, lines: [`ECHEC  ${error.message} : ${vault} n'est pas un coffre (aucun marqueur), la garde ne s'y applique pas ; kioku init pour en creer un`] };
    }
    return { code: EXIT.precondition, lines: [`ECHEC  ${error.message}`] };
  }
  // Un core qui ne sait pas lire ce format ne prouve rien sur ce coffre : refus avant toute sonde.
  const tooOld = formatRefusal(CORE, vault);
  if (tooOld) return { code: EXIT.precondition, lines: [`ECHEC  ${tooOld}`] };
  for (const d of cfg.domains) {
    if (!existsSync(path.join(vault, 'wiki', d))) problems.push(`wiki/${d}/ absent (squelette : kioku plaud --init-structure, ou add-domain)`);
    const rules = cfg.rulesPath(d);
    if (!existsSync(rules)) problems.push(`domains/${d}/rules.md absent : le relecteur ne juge rien dans ce domaine`);
    else if (!/^## Relecture$/m.test(readFileSync(rules, 'utf8'))) problems.push(`domains/${d}/rules.md sans section ## Relecture`);
  }

  const { guard, source, why, double, failOpen } = registeredGuard(vault, { home });
  if (failOpen) notes.push(`hook de garde sans repli \`|| exit 2\` : si son interpreteur disparait, Claude Code ouvre la session sans garde ; commande conseillee : ${GUARD_HOOK_COMMAND(guard)}`);

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

// ---------------------------------------------------------------------------------------------------------------
// Ce que init pose pour le plugin et npm (chantier 2)
// ---------------------------------------------------------------------------------------------------------------

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
// index.md : lu en premier a toute query ; log.md : 5 dernieres entrees lues en debut de session (schema commun).
const journalText = (d, file) =>
  file === 'index.md'
    ? `# Index — ${d}\n\n> Catalogue des pages de l'or, lu en premier a toute query. Une ligne par page : [[dossier/slug]] — resume.\n`
    : `# Journal — ${d}\n\n## [${now()}] schema | creation du domaine\n- source : kioku init / add-domain / upgrade\n- pages touchees : index.md, log.md\n`;
const domainJournals = (vault, d) => {
  for (const f of ['index.md', 'log.md']) create(path.join(vault, 'wiki', d, f), journalText(d, f));
};

export const init = (target, { domains = ['pro', 'perso'], org = null, plaud = false, guardHook = false } = {}) => {
  const vault = path.resolve(target);
  if (path.relative(CORE, vault) === '' ) return { code: EXIT.precondition, lines: ['init : refuse sur le core lui-meme'] };
  // Seul .git est tolere : un depot vide (git init, clone d'un depot neuf) ne porte aucune donnee de coffre.
  if (existsSync(vault) && readdirSync(vault).some((n) => n !== '.git')) return { code: EXIT.precondition, lines: [`init : ${vault} n'est pas vide (seul .git est tolere), rien n'est ecrit`] };
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
    format: VAULT_FORMAT,
    domains: domains.map((id) => (id === org ? { id, extensions: { org: { registry: 'orgs.json' } } } : { id })),
    modules: { ...(plaud ? { plaud: { state: 'tools/plaud-sync' } } : {}), dashboard: {} },
    // Un `claude` lance a nu dans le coffre (sans le lanceur) ouvre une session query du premier domaine, pas un refus.
    default_session: { mode: 'query', domain: domains[0] },
  };
  writeAtomic(path.join(vault, CONFIG_NAME), `${JSON.stringify(config, null, 2)}\n`);
  for (const d of domains) {
    skeleton(vault, d);
    domainJournals(vault, d);
    create(path.join(vault, 'domains', d, 'rules.md'), presetText(known.includes(d) ? d : 'minimal', d));
  }
  if (org) {
    create(
      path.join(vault, 'orgs.json'),
      `${JSON.stringify({ employer: 'employeur', orgs: [{ id: 'employeur', name: 'Employeur (a renommer)', role: 'employer' }], org_required: true }, null, 2)}\n`,
    );
  }
  // La garde : le plugin de la marketplace du core, installe au niveau utilisateur et mis a jour par Claude Code. Le
  // coffre declare seulement qu'il l'utilise (sans version). --guard-hook : repli de developpement, un hook vers la
  // garde de ce clone par chemin absolu (non portable entre machines). L'interpreteur aussi, par chemin absolu : `node`
  // nu depend du PATH de Claude Code (souvent plus court depuis l'app de bureau), et un hook introuvable n'y bloque rien.
  const settings = guardHook
    ? { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|NotebookRead|Bash', hooks: [{ type: 'command', command: GUARD_HOOK_COMMAND(CORE_GUARD) }] }] } }
    : mergeSettings({});
  // Les regles permissions.deny de Kioku (managed.mjs, KIOKU_DENY), en plus de la garde ; celles propres a la machine
  // (un XDG_CONFIG_HOME hors ~/.config) dans settings.local.json, qui ne se versionne pas.
  create(path.join(vault, '.claude', 'settings.json'), `${JSON.stringify(mergeDenyRules(settings), null, 2)}\n`);
  const localRules = localDenyRules();
  if (localRules.length) create(path.join(vault, '.claude', 'settings.local.json'), `${JSON.stringify(mergeDenyRules({}, localRules), null, 2)}\n`);
  create(path.join(vault, SCHEMA_REL), schemaText(guardHook ? {} : { KIOKU_PLUGIN: 'kioku' }));
  create(path.join(vault, 'CLAUDE.md'), readFileSync(path.join(TEMPLATES, 'vault-CLAUDE.md'), 'utf8'));
  create(path.join(vault, '.gitignore'), mergeGitignore('', gitignoreBlock({ plaud })));
  // Fins de ligne LF partout : la gate hache les contenus, la garde compare des chemins ; un CRLF de Windows les fausse.
  create(path.join(vault, '.gitattributes'), '* text=auto eol=lf\n');
  create(path.join(vault, 'package.json'), `${JSON.stringify({ name: path.basename(vault).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), private: true, scripts: managedScripts(domains, { plaud }) }, null, 2)}\n`);
  mkdirSync(path.join(vault, 'inbox'), { recursive: true });

  const d = doctor(vault);
  const next = [
    'etapes suivantes :',
    ...(org ? [`  - remplir le registre des organisations : ${path.join(vault, 'orgs.json')}`] : []),
    `  - completer ${path.join(vault, 'CLAUDE.md')} (contexte propre a ce coffre)`,
    ...(guardHook
      ? ['  - garde : hook vers ce clone (--guard-hook), aucun plugin a installer']
      : [`  - plugin, une fois par machine : ${INSTALL_HINT}`]),
    '  - kioku doctor --live : prouve que Claude Code execute la garde',
    `  - npm run ${domains[0]} : premiere session`,
  ];
  return { code: d.code, lines: [`init : coffre cree dans ${vault} (${domains.join(', ')})`, ...d.lines, ...next] };
};

// ---------------------------------------------------------------------------------------------------------------
// upgrade : amene un coffre existant a la forme courante d'init (parties gerees, voir managed.mjs)
// ---------------------------------------------------------------------------------------------------------------

const readJson = (file) => {
  if (!existsSync(file)) return { data: undefined };
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `${path.basename(file)} illisible (${error instanceof Error ? error.message : String(error)})` };
  }
};
const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
const textOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/**
 * Le plan d'upgrade, sans rien ecrire : [{ rel, before, after }] (before null = creation) et des notes.
 * `only` : restreindre aux fichiers nommes (add-domain : package.json). Leve si la configuration est illisible.
 */
export const planUpgrade = (vault, { only } = {}) => {
  const cfg = loadConfig(vault);
  const plaud = cfg.modules.plaud !== undefined;
  const changes = [];
  const notes = [];
  const want = (rel) => !only || only.includes(rel);
  const put = (rel, after) => {
    const before = textOf(path.join(vault, rel));
    if (before !== after) changes.push({ rel, before, after });
  };

  if (want('package.json')) {
    const r = readJson(path.join(vault, 'package.json'));
    if (r.error || (r.data !== undefined && (r.data === null || typeof r.data !== 'object' || Array.isArray(r.data)))) {
      notes.push(`package.json ${r.error ?? 'n est pas un objet'} : non modifie, scripts a ajouter a la main`);
    } else {
      const pkg = r.data ?? { name: path.basename(vault).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), private: true };
      const m = mergeScripts(pkg.scripts ?? {}, managedScripts(cfg.domains, { plaud }));
      if (m.kept.length) notes.push(`package.json : ${m.kept.join(', ')} occupe(s) par un script maison (sans prefixe kioku), laisse(s)`);
      if (m.stale.length) notes.push(`package.json : ${m.stale.join(', ')} gere(s) mais plus produit(s) par init, laisse(s) : a retirer a la main si inutile(s)`);
      put('package.json', json({ ...pkg, scripts: m.scripts }));
    }
  }
  if (want('.gitignore')) {
    try {
      put('.gitignore', mergeGitignore(textOf(path.join(vault, '.gitignore')) ?? '', gitignoreBlock({ plaud })));
    } catch (error) {
      notes.push(error.message);
    }
  }
  if (want('.gitattributes') && !existsSync(path.join(vault, '.gitattributes'))) put('.gitattributes', '* text=auto eol=lf\n');
  if (want(CONFIG_NAME)) {
    // Ajout seul : rien a ajouter = fichier laisse tel quel (sa mise en forme comprise).
    const text = readFileSync(cfg.file, 'utf8');
    const merged = mergeConfig(JSON.parse(text), { domains: cfg.domains, plaud });
    if (merged.added.length) {
      // Cles de premier niveau seulement : inserees sans reformater le fichier ; sinon, reecriture complete.
      const topLevel = merged.added.every((k) => !k.includes('.'));
      const inPlace = topLevel ? appendTopLevelKeys(text, Object.fromEntries(merged.added.map((k) => [k, merged.config[k]])), merged.config) : null;
      put(CONFIG_NAME, inPlace ?? json(merged.config));
    }
  }
  for (const d of cfg.domains) {
    for (const f of ['index.md', 'log.md']) {
      const rel = path.join('wiki', d, f);
      if (want(rel) && !existsSync(path.join(vault, rel))) put(rel, journalText(d, f));
    }
  }
  if (want(path.join('.claude', 'settings.json'))) {
    const rel = path.join('.claude', 'settings.json');
    const r = readJson(path.join(vault, rel));
    const { guard, source: kind } = registeredGuard(vault, { home: null });
    if (r.error) notes.push(`${rel} ${r.error} : plugin non declare`);
    else if (kind === 'projet' && guard) {
      notes.push(`${rel} : hook de garde du projet present, plugin non active (sinon double garde) ; bascule vers le plugin a faire a la main`);
      // Les regles de refus valent aussi avec un hook du projet : seules elles sont ajoutees.
      const merged = mergeDenyRules(r.data ?? {});
      if (JSON.stringify(merged) !== JSON.stringify(r.data)) put(rel, json(merged));
    } else {
      // Deja a la forme voulue : fichier laisse tel quel, mise en forme comprise.
      const merged = mergeDenyRules(mergeSettings(r.data ?? {}));
      if (JSON.stringify(merged) !== JSON.stringify(r.data)) put(rel, json(merged));
    }
  }
  const localRel = path.join('.claude', 'settings.local.json');
  const localRules = localDenyRules();
  if (want(localRel) && localRules.length) {
    const r = readJson(path.join(vault, localRel));
    if (r.error) notes.push(`${localRel} ${r.error} : regles de refus propres a ce poste non ajoutees`);
    else {
      const merged = mergeDenyRules(r.data ?? {}, localRules);
      if (JSON.stringify(merged) !== JSON.stringify(r.data)) put(localRel, json(merged));
    }
  }
  if (want(SCHEMA_REL)) {
    const { source: kind } = registeredGuard(vault, { home: null });
    put(SCHEMA_REL, schemaText(kind === 'projet' ? {} : { KIOKU_PLUGIN: 'kioku' }));
  }
  return { changes, notes };
};

/** Un diff unifie lisible : git diff --no-index si git est la, sinon avant / apres. */
const showDiff = ({ rel, before, after }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kioku-upgrade-'));
  try {
    const a = path.join(dir, 'avant');
    const b = path.join(dir, 'apres');
    writeFileSync(a, before ?? '');
    writeFileSync(b, after);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8' });
    const body = r.status === 1 ? r.stdout.split('\n').slice(4).join('\n') : `--- avant\n${before ?? ''}\n+++ apres\n${after}`;
    return [`=== ${rel}${before === null ? ' (cree)' : ''}`, body.trimEnd()];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const upgrade = (vaultDir, { write = false } = {}) => {
  const vault = path.resolve(vaultDir);
  let plan;
  try {
    plan = planUpgrade(vault);
  } catch (error) {
    return { code: EXIT.precondition, lines: [`upgrade : ${error.message}`] };
  }
  const notes = plan.notes.map((n) => `note   ${n}`);
  if (!plan.changes.length) return { code: EXIT.ok, lines: ['upgrade : deja a la forme courante, rien a faire', ...notes] };
  if (!write) {
    return {
      code: EXIT.ok,
      lines: [`upgrade : simulation, ${plan.changes.length} fichier(s) a modifier (relance avec --write pour appliquer)`, ...plan.changes.flatMap(showDiff), ...notes],
    };
  }
  const lock = acquire(vault, { owner: 'kioku upgrade' });
  if (!lock.ok) return { code: EXIT.precondition, lines: [`upgrade : ${holderText(lock.held)}, relance apres`] };
  try {
    for (const c of plan.changes) writeAtomic(path.join(vault, c.rel), c.after);
  } finally {
    release(vault);
  }
  const d = doctor(vault);
  return { code: d.code, lines: [`upgrade : ${plan.changes.map((c) => c.rel).join(', ')} mis a jour`, ...notes, ...d.lines] };
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

  const lock = acquire(vault, { owner: 'kioku add-domain' });
  if (!lock.ok) return { code: EXIT.precondition, lines: [`add-domain : ${holderText(lock.held)}, relance apres`] };
  try {
    skeleton(vault, name);
    domainJournals(vault, name);
    create(path.join(vault, 'domains', name, 'rules.md'), presetText(preset, name));
    // La configuration en dernier : tant qu'elle ne declare pas le domaine, la garde le tient ferme.
    const raw = JSON.parse(readFileSync(path.join(vault, CONFIG_NAME), 'utf8'));
    raw.domains.push(description ? { id: name, description } : { id: name });
    writeAtomic(path.join(vault, CONFIG_NAME), `${JSON.stringify(raw, null, 2)}\n`);
  } finally {
    release(vault);
  }
  // Apres la configuration : un script npm vers un domaine non declare serait refuse par le lanceur, sans plus.
  // Meme fusion qu'upgrade, restreinte au package.json : scripts geres du nouveau domaine, maison intacts.
  const plan = planUpgrade(vault, { only: ['package.json'] });
  for (const c of plan.changes) writeAtomic(path.join(vault, c.rel), c.after);
  const scriptNotes = plan.notes.map((n) => `note   ${n}`);
  const d = doctor(vault);
  const head = d.code === EXIT.isolation ? `add-domain : ${name} cree, MAIS le cloisonnement n'est pas prouve : ne t'en sers pas avant de corriger` : `add-domain : ${name} cree (preset ${preset})`;
  return { code: d.code, lines: [head, ...scriptNotes, ...d.lines] };
};

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = [
  'usage :',
  '  kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud] [--guard-hook]',
  '      (le coffre active le plugin kioku@dojo de la marketplace dojo ; --guard-hook : hook vers ce clone, sans plugin)',
  '  kioku add-domain <nom> [--preset <preset>] [--description <texte>] [--vault <dossier>]',
  '  kioku upgrade [--write] [--vault <dossier>]   (simulation par defaut : diff des parties gerees ; --write applique)',
  '  kioku doctor [--live] [--plugin-dir <core>] [--vault <dossier>]   (--live : sonde par une vraie session claude -p)',
  '  kioku session [<domaine>] [--mode ingest|triage|setup] [--lint] [-- <args claude>]   (ouvre une session du coffre)',
  '  kioku dashboard [<domaine>|all] [--serve]   (HTML statique, ou serveur local au premier plan)',
  '  kioku plaud [--dry-run|--skip-fetch|--drop <fichier>|…]   (circuit Plaud du coffre courant)',
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
    const refusal = sessionRefusal(env, { initTarget: cmd === 'init' && positional[0] ? path.resolve(positional[0]) : undefined });
    if (refusal) return { code: EXIT.precondition, lines: [`${cmd} : ${refusal}`] };
  }
  if (cmd === 'init') {
    if (!positional[0]) return { code: EXIT.precondition, lines: [USAGE] };
    const domains = (opt('--domains') ?? 'pro,perso').split(',').map((s) => s.trim()).filter(Boolean);
    return init(positional[0], { domains, org: opt('--org') ?? null, plaud: rest.includes('--plaud'), guardHook: rest.includes('--guard-hook') });
  }
  if (cmd === 'upgrade') {
    // Simulation par defaut : n'ecrit rien sans --write. L'ecriture touche la configuration : setup ou terminal.
    if (rest.includes('--write')) {
      const refusal = sessionRefusal(env);
      if (refusal) return { code: EXIT.precondition, lines: [`upgrade : ${refusal}`] };
    }
    return upgrade(vault, { write: rest.includes('--write') });
  }
  if (cmd === 'add-domain') {
    if (!positional[0]) return { code: EXIT.precondition, lines: [USAGE] };
    return addDomain(vault, positional[0], { preset: opt('--preset') ?? 'minimal', description: opt('--description') });
  }
  return { code: EXIT.precondition, lines: [USAGE] };
};

/**
 * Les outils du core relayes par le CLI (decision 1 du 2026-11-02) : les scripts npm du coffre appellent `kioku <cmd>`
 * via le relais du PATH, qui ne connait que kioku.mjs. Relais transparent : meme dossier courant (le coffre), meme
 * environnement, sortie et code de l'outil. Le cloisonnement reste dans les outils (garde, resolveDomains, lanceur).
 *   session [<D>] [args]      tools/vault.mjs [--domain <D>] [args]   (--mode, --lint, -- passes tels quels)
 *   dashboard [<D>|all]       tools/dashboard/run.mjs                  (HTML statique)
 *   dashboard <D> --serve     tools/dashboard/serve.mjs <D>            (serveur au premier plan, Ctrl-C)
 *   plaud [args]              tools/plaud-sync/run.mjs --vault . [args]
 */
export const toolCommand = (argv) => {
  const [cmd, ...rest] = argv;
  const tools = path.join(CORE, 'tools');
  const first = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
  if (cmd === 'session') return [path.join(tools, 'vault.mjs'), ...(first ? ['--domain', first, ...rest.slice(1)] : rest)];
  if (cmd === 'dashboard') {
    if (rest.includes('--serve')) return [path.join(tools, 'dashboard', 'serve.mjs'), ...rest.filter((a) => a !== '--serve')];
    return [path.join(tools, 'dashboard', 'run.mjs'), ...rest];
  }
  if (cmd === 'plaud') return [path.join(tools, 'plaud-sync', 'run.mjs'), '--vault', '.', ...rest];
  return null;
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const relayed = isDirect ? toolCommand(process.argv.slice(2)) : null;
if (isDirect && GATE_COMMANDS.includes(process.argv[2])) {
  // La gate garde sa sortie et son code (0, 1, 3, 4) : relais transparent, meme repertoire, meme environnement.
  // Hors session (npm run audit:<D> depuis un terminal), CLAUDE_PROJECT_DIR manque et la gate se rabattrait sur
  // l'emplacement de son script (le core) : le coffre est le dossier courant, comme pour les autres outils (vaultRoot).
  const env = process.env.CLAUDE_PROJECT_DIR ? process.env : { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() };
  const r = spawnSync(process.execPath, [GATE, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
} else if (relayed) {
  const r = spawnSync(process.execPath, relayed, { stdio: 'inherit' });
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
