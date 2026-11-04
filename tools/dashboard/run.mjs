/**
 * tools/dashboard/run.mjs
 *
 * Point d'entree CLI et generateur du tableau de bord d'etat du coffre.
 * Usage : `node tools/dashboard/run.mjs [<domaine>|all] [--serve]`
 * Produit : `tools/dashboard/dashboard-<domaine>.html`
 * Les domaines sont ceux de la configuration du coffre (kioku.config.json).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readHeldAndCandidates } from './held-read.mjs';
import { readLocalState } from './local-state.mjs';
import { renderMarkdown } from './markdown.mjs';
import { renderPage } from './page.mjs';
import { setupGracefulShutdown, startServer } from './serve.mjs';
import { readBronzeAndSilverStatus, readGoldTopologyAndIssues, readText } from './vault-read.mjs';
import { assertDomain, loadConfig } from '../vault-config.mjs';

/**
 * Noeuds masques dans la vue entites du graphe : `modules.dashboard.hide.<domaine>` de la configuration du coffre,
 * une liste de `dossier/slug` (ex. la fiche de l'utilisateur, reliee a presque tout). Reglage d'affichage : une
 * valeur mal formee est ignoree avec un avertissement, jamais une erreur (la configuration reste chargeable par la
 * garde, qui ne lit pas ce champ).
 *
 * @returns {string[]}
 */
export const graphHiddenNodes = (vaultRoot, domain, warn = (m) => process.stderr.write(`[dashboard] ${m}\n`)) => {
  const hide = loadConfig(vaultRoot).modules.dashboard?.hide;
  if (hide === undefined) return [];
  if (hide === null || typeof hide !== 'object' || Array.isArray(hide)) {
    warn('modules.dashboard.hide ignore : un objet { "<domaine>": ["dossier/slug", ...] } est attendu');
    return [];
  }
  const list = hide[domain];
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    warn(`modules.dashboard.hide.${domain} ignore : une liste de "dossier/slug" est attendue`);
    return [];
  }
  const ok = list.filter((s) => typeof s === 'string' && /^[^/\s]+\/[^/\s]+$/.test(s));
  if (ok.length !== list.length) warn(`modules.dashboard.hide.${domain} : ${list.length - ok.length} entree(s) ignoree(s), "dossier/slug" attendu`);
  return ok;
};

/**
 * Genere le code HTML complet du tableau de bord pour un domaine donne.
 *
 * @param {string} vaultRoot - Racine absolue du coffre
 * @param {string} domain - un domaine declare dans la configuration du coffre
 * @param {object} [options={}] - Options de rendu (mode, version, now)
 * @returns {string} Document HTML autonome
 */
export const generateDashboardHtml = (vaultRoot, domain, options = {}) => {
  assertDomain(vaultRoot, domain);

  const { mode = 'static', version = null, now = new Date(), askToken = null, assets = null } = options;
  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();

  // 1. Lecture de l'or (topologie du graphe et anomalies)
  const rawGold = readGoldTopologyAndIssues(vaultRoot, domain);

  // 2. Lecture du suivi d'ingestion dans le medaillon
  const medallion = readBronzeAndSilverStatus(vaultRoot, domain);

  // 3. Lecture des etats locaux de la machine (portee locale cloisonnee)
  const localState = readLocalState(vaultRoot, domain);

  // 4. Lecture de la quarantaine et des candidates en attente de la gate
  const heldAndCandidates = readHeldAndCandidates(vaultRoot, domain);

  // 5. Construction des noeuds et des liens serialisables pour le graphe
  const nodes = [];
  const knownPages = new Set();

  for (const [id, p] of rawGold.pages.entries()) {
    knownPages.add(id);
    nodes.push({
      id,
      slug: p.slug,
      title: p.title,
      folder: p.folder,
      isLegacy: p.isLegacy,
      type: p.type || p.folder,
      gate: p.gate || null,
      updated: p.updated || null,
      aliases: p.aliases || [],
      linksCount: p.linksCount || 0,
      phantom: false,
    });
  }

  for (const phantomItem of rawGold.phantomNodes) {
    const phantomId = typeof phantomItem === 'object' ? phantomItem.id : phantomItem;
    const parts = String(phantomId).split('/');
    const slug = parts[parts.length - 1];
    const folder = parts.length > 1 ? parts[0] : 'phantom';
    nodes.push({
      id: phantomId,
      slug,
      title: slug,
      folder,
      isLegacy: false,
      type: 'phantom',
      gate: null,
      updated: null,
      aliases: [],
      linksCount: phantomItem.count || 0,
      phantom: true,
      backlinks: phantomItem.citedBy || [],
    });
  }

  const links = rawGold.edges.map((e) => ({
    source: e.source,
    target: e.target,
    isPhantom: false,
  }));

  for (const phantomItem of rawGold.phantomNodes) {
    const phantomId = typeof phantomItem === 'object' ? phantomItem.id : phantomItem;
    const citedBy = phantomItem.citedBy || [];
    for (const src of citedBy) {
      links.push({
        source: src,
        target: phantomId,
        isPhantom: true,
      });
    }
  }

  const topology = { nodes, links };

  // 6. Indexation des pages connues pour la resolution des wikilinks
  const isKnownPage = (target) => knownPages.has(target);

  // 7. Calcul des liens entrants (backlinks) pour chaque noeud
  const backlinksMap = new Map();
  for (const link of topology.links) {
    const src = link.source;
    const tgt = link.target;
    if (!backlinksMap.has(tgt)) {
      backlinksMap.set(tgt, []);
    }
    backlinksMap.get(tgt).push(src);
  }

  // 8. Pre-rendu du markdown en HTML pour chaque noeud existant
  for (const node of topology.nodes) {
    node.backlinks = backlinksMap.get(node.id) ?? node.backlinks ?? [];
    if (!node.phantom) {
      const pageData = rawGold.pages.get(node.id);
      if (pageData && pageData.text !== undefined) {
        try {
          node.contentHtml = renderMarkdown(pageData.text, { isKnownPage });
        } catch {
          node.contentHtml = '<p><em>Erreur lors de la lecture du fichier markdown.</em></p>';
        }
      } else {
        node.contentHtml = '<p><em>Fichier introuvable sur le disque.</em></p>';
      }
    } else {
      node.contentHtml = '<p><em>Page fantôme non créée dans le domaine.</em></p>';
    }
  }

  // 9. Structuration des anomalies et de la dette technique
  const actionableIssues = [];
  for (const [kind, list] of Object.entries(rawGold.issues.actionable)) {
    for (const item of list) {
      actionableIssues.push({
        kind,
        slug: item.sourceKey,
        detail: item.detail,
      });
    }
  }

  // 3 compteurs dedies pour le bronze anterieur au seed (arbitrage utilisateur)
  const preSeedMeetings = medallion.debtBronzeFiles.filter((f) => f.includes('/meetings/') || f.includes('\\meetings\\')).length;
  const preSeedArticles = medallion.debtBronzeFiles.filter((f) => f.includes('/articles/') || f.includes('\\articles\\')).length;
  const preSeedOthers = medallion.debtBronzeFiles.length - preSeedMeetings - preSeedArticles;

  const debt = {
    legacyPagesCount: rawGold.legacyPagesCount,
    legacyDeadLinksCount: (rawGold.issues.debt['lien-casse'] || []).length,
    preSeedBronzeMeetingsWithoutGoldCount: preSeedMeetings,
    preSeedBronzeArticlesWithoutGoldCount: preSeedArticles,
    preSeedBronzeOthersWithoutGoldCount: preSeedOthers,
  };

  // Lacunes voulues (CLAUDE.md §5.3) : informatives, hors du compteur d'anomalies
  const lacunes = rawGold.lacunes.map((l) => ({ target: l.target, sources: l.sources, isLegacy: l.isLegacy }));

  const issues = {
    actionableIssues,
    debt,
    lacunes,
  };

  const vaultData = {
    graph: { hide: graphHiddenNodes(vaultRoot, domain) },
    domain,
    generatedAt,
    mode,
    version,
    // Jeton de l'onglet 問 Question : seulement dans la page servie en direct, jamais dans un fichier
    askToken: mode === 'live' && askToken ? askToken : null,
    topology,
    issues,
    medallion,
    localState,
    heldAndCandidates,
    // Ressources embarquees (fichier statique seulement, voir writeDashboardFile) ; sinon URLs `vendor/…`
    assets,
  };

  return renderPage(vaultData);
};

const VENDOR_DIR = fileURLToPath(new URL('./vendor', import.meta.url));
const VIDEO_REL = path.join('tools', 'dashboard', 'vendor', 'media', 'kioku-explainer.mp4');

/**
 * Ressources du fichier statique. Il est ecrit dans le coffre, le vendor reste dans le plugin (chemin qui change a
 * chaque version) : polices, script du graphe et sous-titres sont embarques. La video ne l'est pas (trop lourde) :
 * lien relatif vers le mp4 du coffre s'il existe au moment du build, sinon pas de bloc video.
 *
 * @param {string} vaultRoot - Racine absolue du coffre
 * @param {string} outDir - Dossier ou le HTML sera ecrit (base du lien relatif vers la video)
 * @param {string} [vendorDir=VENDOR_DIR] - Vendor du core
 * @returns {{ fonts: Record<string, string>, graphScript: string, video: { mp4: string|null, vtt: string|null } }}
 * @throws {Error} Ressource du core absente, ou script du graphe impossible a embarquer tel quel
 */
export const inlineAssets = (vaultRoot, outDir, vendorDir = VENDOR_DIR) => {
  const need = (rel) => {
    const file = path.join(vendorDir, rel);
    if (!existsSync(file)) throw new Error(`Ressource du dashboard absente : ${file} (installation du plugin incomplete ?)`);
    return file;
  };
  const fontsDir = need('fonts');
  const fonts = {};
  for (const name of readdirSync(fontsDir).filter((n) => n.endsWith('.woff2')).sort()) {
    fonts[name] = `data:font/woff2;base64,${readFileSync(path.join(fontsDir, name)).toString('base64')}`;
  }
  if (Object.keys(fonts).length === 0) throw new Error(`Aucune police dans ${fontsDir}`);

  const graphScript = readFileSync(need('3d-force-graph.min.js'), 'utf8');
  // Embarque tel quel, jamais reecrit : une de ces sequences fermerait ou derouterait la balise <script>.
  const unsafe = ['</script', '<!--', '<script'].find((seq) => graphScript.toLowerCase().includes(seq));
  if (unsafe) throw new Error(`3d-force-graph.min.js contient « ${unsafe} » : impossible de l'embarquer sans le modifier`);

  const mp4 = path.join(vaultRoot, VIDEO_REL);
  const vttFile = path.join(vendorDir, 'media', 'kioku-explainer.vtt');
  const video = existsSync(mp4)
    ? {
        mp4: path.relative(outDir, mp4).split(path.sep).join('/'),
        vtt: existsSync(vttFile) ? `data:text/vtt;base64,${readFileSync(vttFile).toString('base64')}` : null,
      }
    : { mp4: null, vtt: null };

  return { fonts, graphScript, video };
};

/**
 * Genere et ecrit le fichier HTML sur disque, autonome (voir inlineAssets).
 *
 * @param {string} vaultRoot - Racine absolue du coffre
 * @param {string} domain - un domaine declare
 * @param {string} [outDir=null] - Dossier de sortie optionnel
 * @param {object} [options={}] - Options de rendu ; `vendorDir` remplace le vendor du core (tests)
 * @returns {string} Chemin absolu du fichier genere
 */
export const writeDashboardFile = (vaultRoot, domain, outDir = null, options = {}) => {
  const targetDir = outDir || path.join(vaultRoot, 'tools', 'dashboard');
  // Avant tout mkdir : une ressource manquante ne laisse ni dossier ni fichier a moitie fait.
  const assets = inlineAssets(vaultRoot, targetDir, options.vendorDir);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const html = generateDashboardHtml(vaultRoot, domain, { ...options, assets });
  const outFile = path.join(targetDir, `dashboard-${domain}.html`);
  writeFileSync(outFile, html, 'utf8');

  return outFile;
};

/**
 * Resout les domaines a generer en respectant le silo de la session.
 *
 * Dans une session Claude, la garde ne filtre que le texte des commandes : elle ne voit pas ce
 * que ce script lit. Le silo est donc tenu ici. Le domaine de session reprend le defaut de la
 * garde : `default_session` de la configuration, sinon refus (cf. guard.mjs). Sans cela, une
 * session lancee sans `VAULT_DOMAIN` echapperait au controle. Hors session Claude (terminal),
 * aucune restriction ; sans argument, le premier domaine declare.
 *
 * @param {string|undefined} requested - Argument CLI : un domaine declare, 'all' ou absent
 * @param {NodeJS.ProcessEnv} env - Environnement (process.env)
 * @param {string} [vaultRoot=process.cwd()] - Racine du coffre, dont la configuration donne les domaines
 * @returns {string[]} Domaines a generer
 * @throws {Error} Domaine inconnu, ou domaine hors de celui de la session
 */
export const resolveDomains = (requested, env, vaultRoot = path.resolve()) => {
  const cfg = loadConfig(vaultRoot);
  const usage = `Utilisation : node tools/dashboard/run.mjs [${[...cfg.domains, 'all'].join('|')}] [--serve]`;
  const inSession = Boolean(env.CLAUDECODE) || env.VAULT_DOMAIN !== undefined;
  let sessionDomain = null;
  if (inSession) {
    sessionDomain = env.VAULT_DOMAIN ?? (env.VAULT_MODE === undefined ? cfg.defaultSession?.domain : undefined);
    if (sessionDomain === undefined) {
      throw new Error('Session sans VAULT_DOMAIN et sans default_session dans la configuration du coffre. Dans le doute, je refuse.');
    }
    if (!cfg.has(sessionDomain)) throw new Error(`VAULT_DOMAIN invalide : ${sessionDomain}. Dans le doute, je refuse.`);
  }

  const domain = requested || sessionDomain || cfg.domains[0];
  if (domain !== 'all' && !cfg.has(domain)) throw new Error(`Domaine inconnu : ${domain}. ${usage}`);

  if (sessionDomain !== null && domain !== sessionDomain) {
    throw new Error(
      `Session ${sessionDomain} : le dashboard « ${domain} » sortirait du silo. ` +
        `Lance-le depuis un terminal hors session, ou depuis une session ${domain === 'all' ? 'dediee a chaque domaine' : domain}.`
    );
  }

  return domain === 'all' ? [...cfg.domains] : [domain];
};

// Execution en ligne de commande
const isDirectExecution = () => {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
};

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const serveMode = args.includes('--serve');
  let portArg;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--serve') {
      // ignore
    } else if (args[i] === '--port' && args[i + 1]) {
      portArg = parseInt(args[i + 1], 10);
      i++;
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const vaultRoot = path.resolve();

  let domainsToRun;
  try {
    domainsToRun = resolveDomains(filteredArgs[0], process.env, vaultRoot);
  } catch (err) {
    console.error(`[dashboard] ${err.message}`);
    process.exit(1);
  }

  if (serveMode && domainsToRun.length !== 1) {
    console.error("[dashboard] Le serveur ne peut executer qu'un domaine a la fois.");
    process.exit(1);
  }

  const generatedFiles = [];

  for (const d of domainsToRun) {
    const outFile = writeDashboardFile(vaultRoot, d);
    generatedFiles.push(outFile);
    console.log(`[dashboard] Genere avec succes : ${path.relative(vaultRoot, outFile)}`);
  }

  if (serveMode) {
    startServer(vaultRoot, domainsToRun[0], { port: portArg })
      .then(({ close }) => {
        setupGracefulShutdown(close);
      })
      .catch(() => {
        process.exit(1);
      });
  }
}
