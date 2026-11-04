/**
 * tools/dashboard/page.mjs
 *
 * Generation de la page HTML complete du tableau de bord d'etat du coffre.
 * Conforme aux exigences :
 * - Zero reseau (R7, KTD2) : CSS inline, polices locales vendorisees, script vendorise UMD local
 * - Protocole file:// : autonome, aucun import CDN ni module distant
 * - Design Zen / wabi-sabi « Kioku » : theme unique papier washi, encre sumi, pigments mineraux
 *   (une teinte decorative et une variante -ink de texte par pigment, WCAG AA verifie par design.test.mjs)
 * - Navigation par onglets Pilote / Graphe / Mode d'emploi, kanji decoratifs en police systeme
 * - Pipeline Medaillon avec barres de progression dynamiques
 * - File de triage haute densite avec pills CLI compacts et boutons contextuels
 * - Recherche globale au clavier (« / »), filtre de voisinage 1-hop, bascule 2D/3D et zoom
 * - Inspecteur lateral de lecture avec metadonnees frontmatter reelles
 * - Etats locaux a la machine clairement identifies (portee machine locale)
 */

import { escapeHtml } from './markdown.mjs';
import { quarantineLabel } from './held-read.mjs';

export const renderPage = (data) => {
  const { domain, generatedAt, mode = 'static', version = null, askToken = null, topology, issues, medallion, localState, heldAndCandidates } = data;
  // Deux habillages : l'indigo du domaine `pro`, le matcha de tout autre domaine (perso aujourd'hui). Le badge
  // reprend le nom du domaine : un domaine ajoute s'affiche sous son nom, jamais sous celui d'un autre.
  const isPro = domain === 'pro';
  const domainTag = String(domain).toUpperCase();
  const domainBadgeClass = isPro ? 'badge-pro' : 'badge-perso';

  // Calcul des compteurs cles du pipeline Medaillon
  const actionableBronze = medallion?.actionableBronzeWithoutSilver?.length ?? 0;
  const totalBronze = medallion?.totalBronzeCount ?? (actionableBronze + (medallion?.debtBronzeCount ?? 0));

  const actionableSilver = medallion?.actionableSilverWithoutGold?.length ?? 0;
  const totalSilver = medallion?.totalSilverCount ?? actionableSilver;

  const totalQuarantine = heldAndCandidates?.quarantine?.length ?? 0;
  const totalCandidates = heldAndCandidates?.candidates?.length ?? 0;
  const totalGatePending = heldAndCandidates?.totalPendingCount ?? (totalQuarantine + totalCandidates);

  const livingGoldNodes = topology?.nodes ? topology.nodes.filter((n) => !n.phantom) : [];
  const livingGoldPagesCount = livingGoldNodes.length;
  // L'or compte des pages de tous types : on separe les sources (comparables au bronze) des entites.
  const goldSourcesCount = livingGoldNodes.filter((n) => String(n.id).startsWith('sources/')).length;
  const goldEntitiesCount = livingGoldPagesCount - goldSourcesCount;
  const totalActionableIssues = issues?.actionableIssues?.length ?? 0;

  // Bronze : relie (une page or ou une fiche argent cite ce brut), herite (anterieur a l'amorcage, sans lien
  // raw: : probablement ingere avant le medaillon, non rapproche), a faire. Seul le relie compte comme traite.
  const debtBronze = medallion?.debtBronzeCount ?? 0;
  const linkedBronze = Math.max(0, totalBronze - debtBronze - actionableBronze);

  // Calcul des pourcentages de progression
  const bronzeProgress = totalBronze > 0 ? Math.round((linkedBronze / totalBronze) * 100) : 100;
  const silverProgress = totalSilver > 0 ? Math.round(((totalSilver - actionableSilver) / totalSilver) * 100) : 100;
  // La gate n'a pas de ratio qui ait un sens (quarantaine et candidates attendent toutes une action) :
  // la barre est pleine quand la file est degagee, vide sinon. Plus de plancher a 10 % qui laissait croire a une mesure.
  const gateProgress = totalGatePending > 0 ? 0 : 100;
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

  // Construction de la liste unifiee d'actions pour le triage haute densite
  const triageActions = [];

  // Priorite 1 : Quarantaine (Critique / Rouge)
  for (const q of (heldAndCandidates?.quarantine || [])) {
    triageActions.push({
      id: q.id,
      stage: 'gate',
      category: 'Quarantaine',
      severity: 'critical',
      severityLabel: 'Critique',
      title: q.id,
      badge: q.code || 'retenu',
      badgeClass: 'status-held',
      note: `${quarantineLabel(q.kind)}${q.actions ? ` — actions : ${q.actions.join(' | ')}` : ''}${q.note ? ` — ${q.note}` : ''}`,
      target: q.target || q.file || '',
      // Jamais de drop par defaut : il supprime une page retenue ou sort une page de l'or.
      command: q.command || `kioku decide ${domain} ${q.id}`,
      actionLabel: 'Décider',
      linkSlug: null,
    });
  }

  // Priorite 2 : Candidates en attente de gate (Haute / Ambre)
  for (const c of (heldAndCandidates?.candidates || [])) {
    const isReady = c.status === 'ready_to_promote';
    const isHeld = c.status === 'held_by_reviewer';
    triageActions.push({
      id: `${c.folder}/${c.slug}`,
      stage: 'gate',
      category: 'Candidate Gate',
      severity: 'high',
      severityLabel: 'Haute',
      title: `${c.folder}/${c.slug}`,
      badge: c.status,
      badgeClass: isReady ? 'status-ok' : isHeld ? 'status-held' : 'status-pending',
      note: `Verdict gate : ${c.verdict || 'en attente'}`,
      target: `.candidats/wiki/${domain}/${c.folder}/${c.slug}.md`,
      command: c.command || `kioku check .candidats/wiki/${domain}/${c.folder}/${c.slug}.md`,
      actionLabel: isReady ? 'Promouvoir' : isHeld ? 'Consigner' : 'Vérifier',
      linkSlug: null,
    });
  }

  // Priorite 3 : Bronze actionnable sans fiche argent (Normale / Cyan)
  for (const b of (medallion?.actionableBronzeWithoutSilver || [])) {
    const relRaw = b.replace(/^[/\\]+/, '').replace(new RegExp(`^raw[/\\\\]${domain}[/\\\\]`), '');
    triageActions.push({
      id: b,
      stage: 'bronze',
      category: 'Bronze sans fiche Argent',
      severity: 'normal',
      severityLabel: 'Normale',
      title: b,
      badge: 'sans fiche',
      badgeClass: 'status-bronze',
      note: 'Source brute nouvelle en attente de structuration dans silver/',
      target: b,
      command: `npm run ingest:${domain} -- "/ingest ${relRaw}"`,
      actionLabel: 'Ingérer',
      linkSlug: null,
    });
  }

  // Priorite 4 : Fiches argent sans page or (Normale / Violet)
  for (const s of (medallion?.actionableSilverWithoutGold || [])) {
    const slug = typeof s === 'string' ? s : s.slug;
    const rawTarget = typeof s === 'object' && (s.normalizedRaw || s.raw) ? (s.normalizedRaw || s.raw) : slug;
    triageActions.push({
      id: slug,
      stage: 'silver',
      category: 'Argent en attente du Gold',
      severity: 'normal',
      severityLabel: 'Normale',
      title: slug,
      badge: 'attente gold',
      badgeClass: 'status-silver',
      note: 'Fiche argent classee en attente de redaction des pages candidates or',
      target: `silver/${domain}/${slug}.md`,
      command: `npm run ingest:${domain} -- "/ingest ${rawTarget}"`,
      actionLabel: 'Rédiger or',
      linkSlug: null,
    });
  }

  // Priorite 5 : Anomalies exploitables du gold (Avertissement / Orange)
  for (const a of (issues?.actionableIssues || [])) {
    triageActions.push({
      id: `${a.slug}#${a.kind}`,
      stage: 'gold',
      category: 'Anomalies exploitables',
      severity: 'warning',
      severityLabel: 'Audit',
      title: a.slug,
      badge: a.kind,
      badgeClass: 'status-warning',
      note: a.detail,
      target: `wiki/${domain}/${a.slug}.md`,
      command: `npm run audit:${domain}`,
      actionLabel: 'Auditer',
      linkSlug: a.slug,
    });
  }

  const totalTriageCount = triageActions.length;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tableau de bord — ${domain}</title>
  <style>
    /* Polices locales vendorisees (KTD1, U1) : @fontsource 5.3.0, une graisse reelle par fichier, decoupees comme le
       CSS officiel (latin, latin-ext) : le navigateur ne charge que le jeu dont la page a besoin. Licence : vendor/fonts/OFL.txt */
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-400.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-ext-400.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 500;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-500.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 500;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-ext-500.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-600.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url('vendor/fonts/inter-latin-ext-600.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-400.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-ext-400.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 500;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-500.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 500;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-ext-500.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-600.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url('vendor/fonts/jetbrains-mono-latin-ext-600.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }

    /* Tokens washi (clair, defaut) : papier non blanchi, encre sumi, pigments mineraux.
       Chaque pigment a une teinte decorative (pastilles, barres, liseres, noeuds) et une
       variante -ink reservee au texte, calibree a 4,5:1 sur sa surface la plus defavorable
       (renfoncement et teinte -bg composee). Verifie par design.test.mjs.
       Theme unique : le theme sombre a ete retire (choix de design). */
    :root {
      --bg: #F4EFE6;
      --bg-surface: #F4EFE6;
      --bg-card: #ECE6DA;
      --bg-card-hover: #EBE5D8;
      --bg-elevated: #ECE6DA;
      --bg-recess: #EBE5D8;
      --bg-input: #EBE5D8;
      --border: #DDD4C4;
      --border-subtle: #E5DDCF;
      --border-bevel: #DDD4C4;
      --border-strong: #85736B;
      --text: #1E1C1A;
      --text-muted: #5E5A53;
      --text-dim: #625D55;
      --on-accent: #F4EFE6;
      --accent-pro: #2C4459;
      --accent-perso: #4C6545;
      --accent: ${isPro ? '#2C4459' : '#5B7C52'};
      --accent-ink: ${isPro ? '#2C4459' : '#4C6545'};
      --accent-bg: ${isPro ? 'rgba(44, 68, 89, 0.10)' : 'rgba(91, 124, 82, 0.12)'};
      --focus-ring: #845236;
      --danger: #D1402F;
      --danger-ink: #A5372A;
      --danger-bg: rgba(209, 64, 47, 0.10);
      --danger-border: rgba(209, 64, 47, 0.45);
      --warning: #AC782D;
      --warning-ink: #7C5927;
      --warning-bg: rgba(179, 125, 46, 0.10);
      --warning-border: rgba(179, 125, 46, 0.45);
      --success: #5B7C52;
      --success-ink: #4C6545;
      --success-bg: rgba(91, 124, 82, 0.10);
      --success-border: rgba(91, 124, 82, 0.45);
      --info: #557B83;
      --info-ink: #476368;
      --info-bg: rgba(85, 123, 131, 0.10);
      --info-border: rgba(85, 123, 131, 0.45);
      --bronze: #9B5E3C;
      --bronze-ink: #845236;
      --bronze-bg: rgba(155, 94, 60, 0.10);
      --silver: #7A8084;
      --silver-ink: #5C5F62;
      --silver-bg: rgba(122, 128, 132, 0.10);
      --gold: #A77A0D;
      --gold-ink: #7A5B11;
      --gold-bg: rgba(184, 134, 11, 0.10);
      --gate: #D1402F;
      --gate-ink: #A5372A;
      --gate-bg: rgba(209, 64, 47, 0.10);
      --overlay: rgba(244, 239, 230, 0.78);
      --graph-bg: #F4EFE6;
      /* Scene 3D transparente : le papier du conteneur se voit a travers le canvas */
      --graph-scene: rgba(244, 239, 230, 0);
      /* Grain washi : grain fin et net (bruit SVG), teinte encre sumi diluee. Pas de marbrures :
         a grande echelle, elles faisaient flou et la repetition de la tuile se voyait.
         Zone de filtre calee sur la tuile et frequence x taille entiere : raccord sans couture. */
      --graph-paper: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g' x='0' y='0' width='1' height='1'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' seed='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.52 0 0 0 0 0.45 0 0 0 0 0.42 0 0 0 2.2 -0.8'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)' opacity='0.55'/%3E%3C/svg%3E");
      --graph-link: rgba(133, 115, 107, 0.28);
      /* Liens au repos : presque effaces ; nets seulement autour du noeud selectionne */
      --graph-link-rest: rgba(133, 115, 107, 0.09);
      --graph-focus: #9B5E3C;
      /* Pigments de dossier : teintes reparties sur le cercle (OKLCH), chroma de pigment
         mineral (<= 0,15), clartes alternees (sombre / clair) entre teintes voisines. Les plus gros dossiers (reunions, sources,
         concepts, personnes) ont les teintes les plus eloignees. L'ancienne palette mettait
         concepts et personnes dans le meme bleu ardoise, reunions et sources dans le meme
         ocre-olive : indiscernables en lavis. Ecart minimal verifie par design.test.mjs. */
      --folder-people: #3F82BF;        /* gunjo, bleu azurite */
      --folder-projects: #528940;      /* wakatake, jeune bambou */
      --folder-meetings: #AA7E1E;      /* odo, ocre jaune */
      --folder-sources: #2E655D;       /* rokusho sombre, vert-de-gris */
      --folder-concepts: #84265F;      /* enji, laque pourpre */
      --folder-decisions: #9867BC;     /* fuji-murasaki, glycine */
      --folder-organizations: #3B3835; /* sumi, encre */
      --folder-syntheses: #A53B08;     /* shu, vermillon */
      --folder-phantom: rgba(122, 128, 132, 0.4);
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-jp: 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans CJK JP', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.55;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* Focus clavier visible partout : l'habillage retire les cadres qui le portaient */
    :focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }

    /* Kanji decoratifs (KTD2) : police systeme japonaise, jamais seuls (R8) */
    .jp {
      font-family: var(--font-jp);
      font-weight: 400;
      line-height: 1;
    }

    /* En-tete principal de navigation */
    header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      padding: 0 48px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      display: block;
      flex-shrink: 0;
    }

    .brand-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
      font-size: 16px;
      letter-spacing: -0.01em;
    }

    .badge-domain {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--accent-bg);
      color: var(--accent-ink);
      border: 1px solid var(--accent);
    }

    .header-nav {
      display: flex;
      align-items: stretch;
      align-self: stretch;
      gap: 8px;
    }

    .tab-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      padding: 0 14px;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.15s ease, border-color 0.15s ease;
    }
    .tab-btn:hover {
      color: var(--text);
    }
    .tab-btn.active {
      color: var(--text);
      border-bottom-color: var(--bronze);
    }
    .tab-btn .jp {
      font-size: 15px;
      color: var(--text-muted);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .brand-jp {
      font-size: 14px;
      color: var(--text-muted);
    }

    .header-search-btn,
    .header-action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 12px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .header-search-btn:hover,
    .header-action-btn:hover {
      background: var(--bg-recess);
      border-color: var(--border-strong);
    }
    .header-action-btn.active {
      border-color: var(--bronze);
      background: var(--bg-card);
    }
    .icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.25;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .kbd-key {
      font-family: var(--font-mono);
      font-size: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 4px;
      color: var(--text);
    }

    /* Bandeau de mise a jour en direct (U4, KTD4) */
    .update-banner {
      position: sticky;
      top: 64px;
      z-index: 100;
      background: var(--info-bg);
      border-bottom: 1px solid var(--info-border);
      padding: 8px 48px;
      color: var(--text);
      font-size: 13px;
    }
    .update-banner-content {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .update-banner-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .update-banner-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--info);
    }
    .update-banner-btn {
      background: transparent;
      color: var(--info-ink);
      border: 1px solid var(--info-border);
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .update-banner-btn:hover {
      background: var(--info-bg);
    }

    /* Vues du dashboard */
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    #tab-pilot {
      padding: 40px 48px 64px;
      max-width: 1440px;
      margin: 0 auto;
    }

    .section-header {
      margin: 40px 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .section-header:first-child {
      margin-top: 0;
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-num {
      font-family: var(--font-mono);
      color: var(--text-muted);
      letter-spacing: 0;
    }
    .section-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
      display: block;
    }

    /* Plans de papier : pas d'ombre, un filet suffit */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
    }
    .card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Pipeline Medaillon : une bande de quatre etapes separees par des filets */
    .medallion-frise {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }
    .pipeline-step {
      background: transparent;
      border-left: 1px solid var(--border);
      border-top: 2px solid transparent;
      padding: 22px 24px;
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 168px;
    }
    .pipeline-step:first-child {
      border-left: none;
    }
    .pipeline-step:hover {
      background: var(--bg-recess);
    }
    .pipeline-step.active {
      background: var(--bg-card);
      border-top-color: var(--bronze);
    }
    .pipeline-step-gate,
    .pipeline-step-gate:hover,
    .pipeline-step-gate.active {
      background: var(--gate-bg);
      border-top-color: var(--gate);
    }
    .pipeline-step-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .step-identity {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
    }
    .step-dot {
      width: 8px;
      height: 8px;
      border-radius: 1px;
    }
    .dot-bronze { background: var(--bronze); }
    .dot-silver { background: var(--silver); }
    .dot-gate { background: var(--gold); }
    .dot-gate-held { background: var(--gate); }
    .dot-gold { background: var(--gold); }
    .step-mark {
      font-size: 13px;
    }
    .step-name-bronze { color: var(--bronze-ink); }
    .step-name-silver { color: var(--silver-ink); }
    .step-name-gold { color: var(--gold-ink); }
    .step-name-gate { color: var(--gate-ink); }

    .step-path {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .pipeline-step-metric {
      font-size: 44px;
      font-weight: 400;
      line-height: 1.1;
      letter-spacing: -0.02em;
      margin-bottom: 14px;
      color: var(--text);
    }
    .metric-gate { color: var(--gate-ink); }
    .step-breakdown {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      margin: -8px 0 10px;
    }
    .step-flow-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .flow-badge,
    .status-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .status-ok { background: var(--success-bg); color: var(--success-ink); border: 1px solid var(--success-border); }
    .status-warning { background: var(--warning-bg); color: var(--warning-ink); border: 1px solid var(--warning-border); }
    .status-held { background: var(--danger-bg); color: var(--danger-ink); border: 1px solid var(--danger-border); }
    .status-pending { background: var(--info-bg); color: var(--info-ink); border: 1px solid var(--info-border); }
    .status-local { background: var(--silver-bg); color: var(--silver-ink); border: 1px solid var(--border); }
    .status-bronze { background: var(--bronze-bg); color: var(--bronze-ink); border: 1px solid var(--bronze); }
    .status-silver { background: var(--silver-bg); color: var(--silver-ink); border: 1px solid var(--silver); }

    .stage-progress-bar {
      width: 100%;
      height: 2px;
      background: var(--border);
      margin-top: 12px;
      overflow: hidden;
    }
    .stage-progress-fill {
      height: 100%;
      transition: width 0.3s ease;
    }
    .fill-bronze { background: var(--bronze); }
    .fill-silver { background: var(--silver); }
    .fill-gold { background: var(--gold); }
    .fill-gate { background: var(--gate); }

    /* File de triage : un tableau a filets, sans boite */
    .triage-container {
      margin-bottom: 8px;
    }
    .triage-toolbar {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      margin: 40px 0 0;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .triage-toolbar-left {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .triage-toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .action-btn-ghost,
    .action-btn-primary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 500;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .action-btn-primary {
      background: var(--bronze-ink);
      border-color: var(--bronze-ink);
      color: var(--on-accent);
    }
    .action-btn-ghost:hover {
      background: var(--bg-recess);
      border-color: var(--border-strong);
    }
    .action-btn-primary:hover {
      background: var(--bronze);
    }

    .triage-filters {
      display: flex;
      align-items: stretch;
      gap: 4px;
      flex-wrap: wrap;
      width: 100%;
    }
    .filter-pill {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      padding: 6px 12px;
      font-family: var(--font-sans);
      font-size: 14px;
      cursor: pointer;
      transition: color 0.15s ease, border-color 0.15s ease;
    }
    .filter-pill:hover {
      color: var(--text);
    }
    .filter-pill.active {
      color: var(--text);
      border-bottom-color: var(--text);
      font-weight: 500;
    }

    .triage-list {
      display: flex;
      flex-direction: column;
    }
    .triage-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: transparent;
      border-bottom: 1px solid var(--border);
      padding: 14px 16px;
      gap: 16px;
      min-height: 56px;
      transition: background 0.15s ease;
    }
    .triage-item:hover {
      background: var(--bg-recess);
    }
    .triage-item-left {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
      flex: 1;
    }
    .triage-item-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .severity-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .severity-critical { background: var(--danger-bg); color: var(--danger-ink); border: 1px solid var(--danger-border); }
    .severity-high { background: var(--warning-bg); color: var(--warning-ink); border: 1px solid var(--warning-border); }
    .severity-normal { background: var(--info-bg); color: var(--info-ink); border: 1px solid var(--info-border); }
    .severity-warning { background: var(--warning-bg); color: var(--warning-ink); border: 1px solid var(--warning-border); }

    .triage-stage-tag {
      font-size: 12px;
      color: var(--text-muted);
    }
    .triage-item-title {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .triage-item-desc {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mono-target {
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .triage-item-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .cli-pill {
      display: flex;
      align-items: center;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .cli-pill-code {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      padding: 4px 10px;
      max-width: 380px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: all;
    }
    .copy-pill-btn {
      background: var(--bg-surface);
      border: none;
      border-left: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 5px 12px;
      cursor: pointer;
      transition: background 0.15s ease;
      white-space: nowrap;
    }
    .copy-pill-btn:hover {
      background: var(--bg-recess);
    }
    .copy-pill-btn.copy-success {
      background: var(--success-bg);
      color: var(--success-ink);
    }
    .btn-standalone {
      border: 1px solid var(--border);
      border-radius: 4px;
    }

    .empty-state {
      text-align: center;
      padding: 40px 16px;
      color: var(--success-ink);
      border-bottom: 1px solid var(--border);
    }
    .empty-state-title {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    .empty-filtered {
      display: none;
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 13px;
    }
    .metric-desc {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Dette technique repliee */
    .tech-debt-details {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-top: 32px;
    }
    .tech-debt-summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      user-select: none;
    }
    .tech-debt-summary::-webkit-details-marker { display: none; }
    .tech-debt-summary-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .tech-debt-icon {
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.2s ease;
    }
    .tech-debt-details[open] .tech-debt-icon {
      transform: rotate(90deg);
    }
    .tech-debt-title {
      font-size: 17px;
      font-weight: 500;
    }
    .tech-debt-hint {
      font-size: 13px;
      color: var(--text-muted);
    }
    .badge-count {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 2px 8px;
      border-radius: 4px;
    }
    .badge-debt {
      background: var(--warning-bg);
      border-color: var(--warning-border);
      color: var(--warning-ink);
    }
    .tech-debt-body {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    /* Etats locaux a la machine */
    .local-badge {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 4px;
      margin-bottom: 16px;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .dashboard-grid > .card {
      background: transparent;
      border: none;
      border-radius: 0;
      border-left: 1px solid var(--border);
    }
    .dashboard-grid > .card:first-child {
      border-left: none;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table tr {
      border-bottom: 1px solid var(--border-subtle);
    }
    .data-table tr:last-child {
      border-bottom: none;
    }
    .data-table td {
      padding: 10px 4px;
      color: var(--text-muted);
    }
    .cell-num {
      text-align: right;
      font-weight: 500;
      color: var(--text);
    }
    .cell-right {
      text-align: right;
    }

    /* Vue Graphe 3D / 2D */
    #tab-graph {
      position: relative;
      height: calc(100vh - 64px);
      overflow: hidden;
    }
    #graph-container {
      width: 100%;
      height: 100%;
      background-color: var(--graph-bg);
      background-image: var(--graph-paper);
      background-size: 200px 200px;
    }
    .graph-controls {
      position: absolute;
      top: 20px;
      left: 20px;
      z-index: 20;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 320px;
      max-width: 460px;
    }
    .graph-search-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .graph-search-input {
      flex: 1;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 6px 10px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .graph-search-input:focus {
      border-color: var(--bronze);
    }
    .graph-toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .folder-toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    /* Puces de dossier : le pigment pour le lisere et la pastille, l'encre pour le texte (R5) */
    .folder-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }
    .folder-tag::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--folder-color);
    }
    .folder-tag.active {
      border-color: var(--folder-color);
      background: var(--bg-surface);
    }
    .folder-tag.inactive {
      color: var(--text-muted);
      text-decoration: line-through;
    }
    .folder-tag[data-folder="people"] { --folder-color: var(--folder-people); }
    .folder-tag[data-folder="projects"] { --folder-color: var(--folder-projects); }
    .folder-tag[data-folder="meetings"] { --folder-color: var(--folder-meetings); }
    .folder-tag[data-folder="sources"] { --folder-color: var(--folder-sources); }
    .folder-tag[data-folder="concepts"] { --folder-color: var(--folder-concepts); }
    .folder-tag[data-folder="decisions"] { --folder-color: var(--folder-decisions); }
    .folder-tag[data-folder="organizations"] { --folder-color: var(--folder-organizations); }
    .folder-tag[data-folder="syntheses"] { --folder-color: var(--folder-syntheses); }
    .folder-tag[data-folder="phantom"] { --folder-color: var(--folder-phantom); }
    .graph-toolbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .graph-btn-group {
      display: flex;
      gap: 4px;
    }
    .node-count-label {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .graph-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 4px 9px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .graph-btn:hover {
      background: var(--bg-recess);
      border-color: var(--border-strong);
    }

    /* Panneau lateral de lecture : une feuille posee sur le papier */
    #reader-panel {
      position: absolute;
      top: 20px;
      right: 20px;
      bottom: 20px;
      width: 480px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      z-index: 30;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #reader-panel.open {
      display: flex;
    }
    .reader-header {
      padding: 24px 32px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .reader-title-area {
      flex: 1;
      min-width: 0;
    }
    .reader-title {
      font-size: 20px;
      font-weight: 500;
      color: var(--text);
      line-height: 1.3;
      word-break: break-word;
    }
    .reader-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .reader-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .reader-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .close-reader-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      width: 26px;
      height: 26px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s ease;
    }
    .close-reader-btn:hover {
      background: var(--bg-recess);
      color: var(--text);
    }
    .reader-body {
      padding: 24px 32px 32px;
      overflow-y: auto;
      flex: 1;
      font-size: 14px;
      line-height: 1.75;
    }
    .reader-body > * + * {
      margin-top: 0.9em;
    }
    .reader-body h1, .reader-body h2, .reader-body h3 {
      font-weight: 500;
      line-height: 1.35;
      margin-top: 1.6em;
    }
    .reader-body ul, .reader-body ol {
      padding-left: 1.4em;
    }
    .reader-body li + li {
      margin-top: 0.35em;
    }

    .links-section {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .links-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .links-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .wikilink {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent-ink);
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 4px;
      text-decoration: none;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    .wikilink:hover {
      border-color: var(--accent);
    }
    .wikilink-broken {
      color: var(--text-muted);
      border-style: dashed;
    }

    /* Repli WebGL (graphe indisponible) */
    .webgl-error {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 32px;
    }
    .webgl-error-sheet {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px;
      max-width: 560px;
      color: var(--text);
      text-align: center;
    }
    .webgl-error-sheet h3 {
      font-size: 18px;
      font-weight: 500;
      color: var(--danger-ink);
      margin-bottom: 8px;
    }
    .webgl-error-sheet p,
    .webgl-error-sheet ol {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.6;
    }
    .webgl-error-sheet code {
      display: inline-block;
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      color: var(--danger-ink);
      font-size: 12px;
    }
    .webgl-error-help {
      margin: 16px 0 20px;
      padding: 16px;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      border-radius: 4px;
      text-align: left;
    }
    .webgl-error-help ol {
      padding-left: 20px;
    }
    .webgl-error-help strong {
      color: var(--text);
    }

    /* Palette de recherche globale modale (KTD4, R9) */
    .search-palette-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 96px;
    }
    .search-palette-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--overlay);
    }
    .search-palette-window {
      position: relative;
      background: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      width: 600px;
      max-width: calc(100vw - 32px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .search-palette-header {
      display: flex;
      align-items: center;
      padding: 14px 18px;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      color: var(--text-muted);
    }
    .search-palette-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 15px;
      outline: none;
    }
    .search-palette-results {
      max-height: 360px;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .search-palette-hint {
      padding: 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    .search-palette-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.1s ease;
    }
    .search-palette-item:hover, .search-palette-item.selected {
      background: var(--bg-recess);
    }
    .search-palette-item-title {
      font-weight: 500;
      color: var(--text);
    }
    .search-palette-alias {
      font-size: 11px;
      color: var(--text-muted);
    }
    .search-palette-folder {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      border: 1px solid var(--border);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .search-palette-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      padding: 8px 18px;
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
    }
    .search-palette-footer kbd {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      padding: 1px 4px;
      border-radius: 3px;
      color: var(--text-muted);
    }

    /* Mode d'emploi : une page de livre, colonne de lecture centree */
    #tab-guide {
      padding: 48px 48px 80px;
      max-width: 800px;
      margin: 0 auto;
    }
    .guide-hero {
      margin-bottom: 48px;
    }
    .guide-kicker {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 18px;
    }
    .guide-hero h1 {
      font-size: 30px;
      font-weight: 500;
      letter-spacing: -0.02em;
      margin-bottom: 18px;
    }
    .guide-hero p {
      color: var(--text);
      font-size: 15px;
      line-height: 1.75;
    }
    .guide-video {
      margin: 0 0 48px;
    }
    .guide-video video {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .guide-video figcaption {
      margin-top: 10px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .guide-hero code,
    .layer-details code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      padding: 0 4px;
      border-radius: 3px;
    }
    #tab-guide .section-title {
      font-size: 17px;
      font-weight: 500;
      letter-spacing: -0.01em;
      text-transform: none;
      color: var(--text);
      margin: 48px 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    #tab-guide .section-num {
      font-size: 12px;
    }
    .medallion-pipeline {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    .layer-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
    }
    .layer-card.quarantine {
      background: var(--gate-bg);
      border-color: var(--danger-border);
    }
    .layer-badge {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 7px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 12px;
    }
    .layer-badge-bronze { background: var(--bronze-bg); color: var(--bronze-ink); border: 1px solid var(--bronze); }
    .layer-badge-silver { background: var(--silver-bg); color: var(--silver-ink); border: 1px solid var(--silver); }
    .layer-badge-gold { background: var(--gold-bg); color: var(--gold-ink); border: 1px solid var(--gold); }
    .layer-badge-gate { background: var(--gate-bg); color: var(--gate-ink); border: 1px solid var(--gate); }
    .layer-card h3 {
      font-size: 15px;
      font-weight: 500;
      margin-bottom: 8px;
      font-family: var(--font-mono);
    }
    .layer-card p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 12px;
    }
    .layer-details {
      font-size: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      line-height: 1.6;
    }
    .command-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .command-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 18px;
    }
    .command-card h3 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    .command-card p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 12px;
    }
    .command-card .cli-pill {
      justify-content: space-between;
    }
    .command-card .cli-pill-code {
      max-width: none;
    }
    .rule-box {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 2px solid var(--gate);
      border-radius: 4px;
      padding: 18px 20px;
      font-size: 14px;
      line-height: 1.7;
    }
    .rule-box p {
      margin-top: 6px;
      color: var(--text-muted);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }

    /* Onglet 問 Question : colonne de lecture centree, sans bulle ni avatar ni cadre (esquisse validee) */
    #tab-question {
      padding: 40px 24px 180px;
      max-width: 760px;
      margin: 0 auto;
    }
    /* L'attribut hidden l'emporte sur les display des classes reprises (.header-action-btn) */
    #tab-question [hidden] {
      display: none !important;
    }
    .question-intro {
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding-bottom: 16px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .question-kanji {
      font-size: 28px;
      color: var(--text-muted);
    }
    .question-intro h1 {
      font-size: 18px;
      font-weight: 500;
    }
    .question-intro p,
    .question-offline p {
      font-size: 13px;
      color: var(--text-muted);
    }
    .question-offline code {
      display: inline-block;
      margin-top: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--bg-recess);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 10px;
    }
    .question-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .question-link {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      cursor: pointer;
      padding: 2px 4px;
    }
    .question-link:hover:not(:disabled) {
      color: var(--text);
    }
    .question-link:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .question-empty {
      padding: 32px 0;
    }
    .question-empty p {
      font-size: 15px;
      margin-bottom: 14px;
    }
    .question-examples {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .question-example {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 12px;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      cursor: pointer;
    }
    .question-example:hover {
      background: var(--bg-recess);
      border-color: var(--border-strong);
    }
    .question-turn {
      margin-top: 28px;
    }
    .question-ask {
      border-left: 2px solid var(--bronze);
      padding: 2px 0 2px 14px;
      margin-bottom: 14px;
      font-weight: 500;
      white-space: pre-wrap;
    }
    .question-who {
      display: block;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 400;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .question-ask .question-who {
      color: var(--bronze-ink);
    }
    .question-answer {
      padding-left: 16px;
    }
    .question-trace {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-muted);
      background: var(--bg-recess);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 8px 12px;
      margin-bottom: 10px;
    }
    .question-trace b {
      font-weight: 400;
      color: var(--text);
    }
    .question-stream {
      white-space: pre-wrap;
    }
    /* Fin de ligne pendant l'ecriture : un trait de pinceau bronze, pas un bloc */
    .question-stream.is-writing::after {
      content: '';
      display: inline-block;
      width: 2px;
      height: 1em;
      margin-left: 2px;
      background: var(--bronze);
      vertical-align: -2px;
    }
    .question-stream.is-writing:empty::after {
      display: none;
    }
    /* Attente du premier mot : une phrase japonaise s'ecrit puis s'efface, sa traduction a cote */
    .question-waiting {
      display: flex;
      align-items: baseline;
      gap: 12px;
      min-height: 28px;
    }
    .question-waiting-jp {
      font-size: 17px;
      letter-spacing: 0.08em;
      color: var(--text);
    }
    .question-waiting-jp::after {
      content: '';
      display: inline-block;
      width: 1px;
      height: 1em;
      margin-left: 3px;
      background: var(--bronze);
      vertical-align: -2px;
    }
    .question-waiting-fr {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .question-body p {
      margin-bottom: 10px;
    }
    .question-body h3 {
      font-size: 13px;
      font-weight: 600;
      margin: 14px 0 6px;
    }
    .question-body ul,
    .question-body ol {
      margin: 0 0 10px 18px;
    }
    .question-state {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--warning-ink);
      margin-top: 8px;
    }
    .question-composer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--bg);
      border-top: 1px solid var(--border);
      padding: 16px 24px 18px;
      z-index: 40;
    }
    .question-composer-row {
      max-width: 760px;
      margin: 0 auto;
    }
    /* Le champ porte le cadre ; le bouton vit dedans, en bas a droite */
    .question-field {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 6px 6px 12px;
    }
    .question-field:focus-within {
      border-color: var(--border-strong);
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
    .question-field textarea {
      flex: 1;
      min-height: 32px;
      max-height: 200px;
      resize: none;
      background: transparent;
      border: none;
      outline: none;
      padding: 5px 0;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
    }
    .question-field textarea:disabled {
      color: var(--text-muted);
    }
    .question-send {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      padding: 5px 10px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      cursor: pointer;
    }
    .question-send:hover {
      background: var(--bg-recess);
    }
    .question-hint {
      max-width: 760px;
      margin: 6px auto 0;
      display: flex;
      justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Responsive < 768px : onglets sur une seconde ligne, boutons reduits a l'icone */
    @media (max-width: 768px) {
      header {
        height: auto;
        flex-wrap: wrap;
        padding: 10px 16px 0;
        gap: 8px;
      }
      .header-left {
        flex-wrap: wrap;
        width: 100%;
      }
      .header-nav {
        order: 3;
        width: 100%;
        align-self: auto;
        overflow-x: auto;
      }
      .tab-btn {
        padding: 10px;
      }
      .header-right {
        position: absolute;
        top: 12px;
        right: 16px;
        gap: 8px;
      }
      #sync-indicator,
      .btn-label,
      .header-search-btn .kbd-key {
        display: none;
      }
      .update-banner {
        top: 0;
        padding: 8px 16px;
      }
      #tab-pilot, #tab-guide {
        padding: 24px 16px 48px;
      }
      #tab-graph {
        height: calc(100vh - 112px);
      }
      .medallion-frise, .dashboard-grid, .medallion-pipeline {
        grid-template-columns: 1fr;
      }
      .pipeline-step, .dashboard-grid > .card {
        border-left: none;
        border-top: 1px solid var(--border);
      }
      .graph-controls {
        left: 8px;
        right: 8px;
        min-width: 0;
      }
      #reader-panel {
        left: 8px;
        right: 8px;
        width: auto;
      }
      .triage-item {
        flex-direction: column;
        align-items: flex-start;
      }
      .triage-item-right {
        width: 100%;
        justify-content: flex-end;
      }
      .cli-pill-code {
        max-width: 220px;
      }
    }
  </style>
</head>
<body>
  <!-- Annonceur vocal accessible pour les copies -->
  <div id="sr-announcer" class="sr-only" aria-live="polite"></div>

  <header>
    <div class="header-left">
      <!-- Sceau hanko 脳 (maquette Stitch, recadre en 40 x 40) -->
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="28" height="28" fill="none" role="img" aria-label="Sceau Kioku">
        <rect x="2.5" y="2.5" width="35" height="35" rx="6" stroke="var(--gate)" stroke-width="2.2" stroke-dasharray="34 1 26 1 20 1" stroke-linecap="round"/>
        <rect x="5" y="5" width="30" height="30" rx="4.5" fill="var(--gate-bg)"/>
        <path d="M12.7 10.7C12.7 14 12.3 20 10.3 26M12.7 11.3C14 11 15.3 10.7 16.7 10.7C16.7 16 16.7 22 16.3 28C15.7 29.3 14.3 29.7 13 29.3M12.7 16C14 16 15.7 15.7 16.3 15.7M12.3 21C13.7 21 15.3 20.7 16.3 20.7M19 12.7C20.3 12 22.7 11.3 25 10.7M22.3 12C22 14.3 20.7 16.7 18.7 18.3M25 13C26 14.7 27.3 16.7 28 18M21 17.7C23 17.3 25 17 26.7 17M19.3 21.3C22.3 21 25.3 20.7 28.3 20.3M23 21C23 24 23 27.3 22.3 28.7C21.7 29.7 20.3 29.7 19.3 29M20 24C19.3 25.3 18.3 26.7 17.3 27.7M25.3 23.7C26.7 25.3 28 27 29.3 28.3" stroke="var(--gate)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="brand-title">
        <span>Kioku</span>
        <span class="jp brand-jp" lang="ja" aria-hidden="true">記憶</span>
        <span class="badge-domain ${domainBadgeClass}">${domainTag}</span>
      </div>
    </div>
    <nav class="header-nav" aria-label="Onglets du tableau de bord">
      <button id="btn-pilot" class="tab-btn active" aria-current="page" onclick="switchTab('pilot')"><span class="jp" lang="ja" aria-hidden="true">舵</span><span>Pilote</span></button>
      <button id="btn-graph" class="tab-btn" onclick="switchTab('graph')"><span class="jp" lang="ja" aria-hidden="true">図</span><span>Graphe</span></button>
      <button id="btn-question" class="tab-btn" onclick="switchTab('question')"><span class="jp" lang="ja" aria-hidden="true">問</span><span>Question</span></button>
    </nav>
    <div class="header-right">
      <span id="sync-indicator">Généré le ${new Date(generatedAt).toLocaleString('fr-FR')}</span>
      <button id="btn-guide" class="header-action-btn" onclick="switchTab('guide')" title="Ouvrir le Mode d'emploi" aria-label="Mode d'emploi">
        <span class="jp" lang="ja" aria-hidden="true">書</span>
        <span class="btn-label">Mode d'emploi</span>
      </button>
      <button id="btn-search-trigger" class="header-search-btn" onclick="openSearchPalette()" title="Ouvrir la recherche globale" aria-label="Rechercher">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <span class="btn-label">Rechercher</span>
        <kbd class="kbd-key">/</kbd>
      </button>
    </div>
  </header>

  <!-- Bandeau de notification de modification (U4, KTD4, R5) -->
  <div id="update-banner" class="update-banner" style="display: none;">
    <div class="update-banner-content">
      <div class="update-banner-left">
        <span class="update-banner-dot"></span>
        <span id="update-banner-text">Le coffre a été modifié.</span>
      </div>
      <button class="update-banner-btn" onclick="window.location.reload()">Recharger</button>
    </div>
  </div>

  <!-- Onglet 1 : Pilote -->
  <main id="tab-pilot" class="tab-content active">
    <!-- 1. Bande des etapes du pipeline Medaillon (R1, R2, R3, AE1) -->
    <div class="section-header">
      <h2 class="section-title"><span class="section-num">01 //</span><span>Suivi de l'ingestion (Médaillon)</span></h2>
      <span class="section-subtitle">Architecture Médaillon : du brut entrant au graphe de connaissances vivant</span>
    </div>

    <div class="medallion-frise">
      <!-- 1. Bronze (Brut) -->
      <div class="pipeline-step" data-filter-stage="bronze" onclick="filterTriage('bronze', this)" title="Cliquer pour filtrer la file de triage sur le Bronze">
        <div class="pipeline-step-header">
          <div class="step-identity step-name-bronze">
            <span class="step-dot dot-bronze"></span>
            <span class="jp step-mark" lang="ja" aria-hidden="true">銅</span>
            <span class="step-name">1. Bronze (Brut)</span>
          </div>
          <span class="step-path">raw/${domain}/</span>
        </div>
        <div class="pipeline-step-metric">${totalBronze}</div>
        <div class="step-breakdown">${linkedBronze} reliés · ${debtBronze} hérités · ${actionableBronze} à faire</div>
        <div class="step-flow-status">
          ${actionableBronze > 0
            ? `<span class="flow-badge status-warning">${actionableBronze} sans fiche argent</span>`
            : `<span class="flow-badge status-ok">✓ Toutes traitées</span>`}
          <span title="Part du brut relié à une fiche argent ou une page or ; l'hérité non rapproché n'est pas compté">${bronzeProgress}%</span>
        </div>
        <div class="stage-progress-bar">
          <div class="stage-progress-fill" style="width: ${bronzeProgress}%; background: var(--bronze);"></div>
        </div>
      </div>

      <!-- 2. Argent (Fiches) -->
      <div class="pipeline-step" data-filter-stage="silver" onclick="filterTriage('silver', this)" title="Cliquer pour filtrer la file de triage sur l'Argent">
        <div class="pipeline-step-header">
          <div class="step-identity step-name-silver">
            <span class="step-dot dot-silver"></span>
            <span class="jp step-mark" lang="ja" aria-hidden="true">銀</span>
            <span class="step-name">2. Argent (Fiches)</span>
          </div>
          <span class="step-path">silver/${domain}/</span>
        </div>
        <div class="pipeline-step-metric">${totalSilver}</div>
        <div class="step-flow-status">
          ${actionableSilver > 0
            ? `<span class="flow-badge status-warning">${actionableSilver} en attente gold</span>`
            : `<span class="flow-badge status-ok">✓ Tout promu</span>`}
          <span>${silverProgress}%</span>
        </div>
        <div class="stage-progress-bar">
          <div class="stage-progress-fill" style="width: ${silverProgress}%; background: var(--silver);"></div>
        </div>
      </div>

      <!-- 3. Gate & Quarantaine : seule etape en vermillon (R4, AE1) -->
      <div class="pipeline-step pipeline-step-gate" data-filter-stage="gate" onclick="filterTriage('gate', this)" title="Cliquer pour filtrer la file de triage sur la Gate et la Quarantaine">
        <div class="pipeline-step-header">
          <div class="step-identity step-name-gate">
            <span class="step-dot ${totalQuarantine > 0 ? 'dot-gate-held' : 'dot-gate'}"></span>
            <span class="jp step-mark" lang="ja" aria-hidden="true">関</span>
            <span class="step-name">3. Gate & Quarantaine</span>
          </div>
          <span class="step-path">.candidats/ & quarantine/</span>
        </div>
        <div class="pipeline-step-metric metric-gate">${totalGatePending}</div>
        <div class="step-breakdown">${totalQuarantine} quarantaine · ${plural(totalCandidates, 'candidate')}</div>
        <div class="step-flow-status">
          ${totalQuarantine > 0
            ? `<span class="flow-badge status-held">${totalQuarantine} en quarantaine</span>`
            : totalCandidates > 0
            ? `<span class="flow-badge status-pending">${totalCandidates} candidate${totalCandidates > 1 ? 's' : ''}</span>`
            : `<span class="flow-badge status-ok">✓ File dégagée</span>`}
          <span>${totalGatePending > 0 ? 'à décider' : ''}</span>
        </div>
        <div class="stage-progress-bar">
          <div class="stage-progress-fill" style="width: ${gateProgress}%; background: ${totalQuarantine > 0 ? 'var(--gate)' : 'var(--gold)'};"></div>
        </div>
      </div>

      <!-- 4. Or (Wiki) -->
      <div class="pipeline-step" data-filter-stage="gold" onclick="filterTriage('gold', this)" title="Cliquer pour filtrer la file de triage sur l'Or et ses anomalies">
        <div class="pipeline-step-header">
          <div class="step-identity step-name-gold">
            <span class="step-dot dot-gold"></span>
            <span class="jp step-mark" lang="ja" aria-hidden="true">金</span>
            <span class="step-name">4. Or (Wiki vivant)</span>
          </div>
          <span class="step-path">wiki/${domain}/</span>
        </div>
        <div class="pipeline-step-metric">${livingGoldPagesCount}</div>
        <div class="step-breakdown">${plural(goldSourcesCount, 'source')} · ${plural(goldEntitiesCount, 'entité')}</div>
        <div class="step-flow-status">
          ${totalActionableIssues > 0
            ? `<span class="flow-badge status-held">${totalActionableIssues} anomalie${totalActionableIssues > 1 ? 's' : ''}</span>`
            : `<span class="flow-badge status-ok">✓ Zéro anomalie</span>`}
          <span>100%</span>
        </div>
        <div class="stage-progress-bar">
          <div class="stage-progress-fill" style="width: 100%; background: var(--gold);"></div>
        </div>
      </div>
    </div>

    <!-- 2. File de triage ordonnee par criticite (R4, R5, R6, AE2) -->
    <div class="triage-container">
      <div class="triage-toolbar">
        <div class="triage-toolbar-left">
          <h2 class="section-title">
            <span class="section-num">02 //</span>
            <span>Actions prioritaires & Triage</span>
            <span id="triage-count-badge" class="badge-count">${totalTriageCount} action${totalTriageCount > 1 ? 's' : ''}</span>
          </h2>
          <span class="section-subtitle">File ordonnée par criticité avec commande copiable en un clic</span>
        </div>

        <div class="triage-toolbar-actions">
          <button class="action-btn-ghost" data-cmd="npm run plaud:sync" onclick="copyCmd(this)">＋ Nouvelle capture</button>
          <button class="action-btn-primary" data-cmd="npm run plaud:sync" onclick="copyCmd(this)">▶ Exécuter pipeline</button>
        </div>

        <div class="triage-filters">
          <button class="filter-pill active" data-filter="all" onclick="filterTriage('all', this)">Toutes (${totalTriageCount})</button>
          <button class="filter-pill" data-filter="gate" onclick="filterTriage('gate', this)">Gate & Quarantaine (${totalGatePending})</button>
          <button class="filter-pill" data-filter="bronze" onclick="filterTriage('bronze', this)">Bronze sans argent (${actionableBronze})</button>
          <button class="filter-pill" data-filter="silver" onclick="filterTriage('silver', this)">Argent sans gold (${actionableSilver})</button>
          <button class="filter-pill" data-filter="gold" onclick="filterTriage('gold', this)">Anomalies gold (${totalActionableIssues})</button>
        </div>
      </div>

      ${totalTriageCount === 0
        ? `<div class="empty-state">
            <div class="empty-state-title">✓ Aucune action immédiate requise</div>
            <div class="metric-desc">Toutes les sources bronze sont traitées, aucune candidate n'est bloquée et le graphe gold est intègre.</div>
          </div>`
        : `<div class="triage-list" id="triage-list">
            ${triageActions
              .map(
                (item) => `
              <div class="triage-item" data-stage="${escapeHtml(item.stage)}" data-severity="${escapeHtml(item.severity)}">
                <div class="triage-item-left">
                  <div class="triage-item-meta">
                    <span class="severity-badge severity-${escapeHtml(item.severity)}">${escapeHtml(item.severityLabel)}</span>
                    <span class="status-badge ${escapeHtml(item.badgeClass)}">${escapeHtml(item.badge)}</span>
                    <span class="triage-stage-tag">${escapeHtml(item.category)}</span>
                  </div>
                  <div class="triage-item-title">${escapeHtml(item.title)}</div>
                  <div class="triage-item-desc">${escapeHtml(item.note)} ${item.target ? `• <span class="mono-target">${escapeHtml(item.target)}</span>` : ''}</div>
                </div>
                <div class="triage-item-right">
                  <div class="cli-pill" title="${escapeHtml(item.command)}">
                    <span class="cli-pill-code">${escapeHtml(item.command)}</span>
                    <button class="copy-pill-btn" data-cmd="${escapeHtml(item.command)}" onclick="copyCmd(this)">${escapeHtml(item.actionLabel || 'Copier')}</button>
                  </div>
                  ${item.linkSlug ? `<button class="copy-pill-btn btn-standalone" data-slug="${escapeHtml(item.linkSlug)}" onclick="focusNodeInGraph(this.dataset.slug)">Voir graphe</button>` : ''}
                </div>
              </div>`
              )
              .join('')}
            <div id="triage-empty-filtered" class="empty-filtered">
              Aucun élément dans cette catégorie.
            </div>
          </div>`
      }
    </div>

    <!-- Lacunes voulues (CLAUDE.md §5.3) : informatives, hors du compteur d'anomalies -->
    <details class="tech-debt-details">
      <summary class="tech-debt-summary">
        <div class="tech-debt-summary-left">
          <span class="tech-debt-icon">▶</span>
          <span class="tech-debt-title">Lacunes</span>
          <span class="badge-count badge-debt">${issues?.lacunes?.length ?? 0} cible${(issues?.lacunes?.length ?? 0) > 1 ? 's' : ''}</span>
        </div>
        <span class="tech-debt-hint">Pages pas encore créées, citées par une seule source : rien à corriger</span>
      </summary>
      <div class="tech-debt-body">
        <div class="metric-desc">
          Un lien vers une page inexistante, cité par une seule source, est une lacune voulue (CLAUDE.md §5.3).
          Il devient une anomalie à la deuxième source, ou s'il vise une page existante sous un autre nom.
          Le lint juge en plus si la cible est centrale à sa source.
        </div>
        <table class="data-table">
          <tbody>
            ${(issues?.lacunes ?? [])
              .map(
                (l) => `<tr>
              <td>${escapeHtml(l.target)}</td>
              <td style="text-align: right;">${escapeHtml(l.sources.join(', '))}${l.isLegacy ? ' (hérité)' : ''}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </details>

    <!-- 3. Dette technique de l'ancien fonds repliee (R10, KTD6) -->
    <details class="tech-debt-details">
      <summary class="tech-debt-summary">
        <div class="tech-debt-summary-left">
          <span class="tech-debt-icon">▶</span>
          <span class="tech-debt-title">Dette technique (Fonds hérité)</span>
          <span class="badge-count badge-debt">${issues?.debt?.legacyPagesCount ?? 0} pages héritées</span>
        </div>
        <span class="tech-debt-hint">Cliquer pour afficher l'historique hérité</span>
      </summary>
      <div class="tech-debt-body">
        <div class="metric-desc">
          Pages héritées sans ligne gate:, isolées pour ne pas polluer l'action immédiate.
        </div>
        <table class="data-table">
          <tbody>
            <tr>
              <td>Pages d'or héritées sans gate</td>
              <td style="text-align: right; font-weight: 600;">${issues?.debt?.legacyPagesCount ?? 0}</td>
            </tr>
            <tr>
              <td>Cibles fantômes issues de l'hérité</td>
              <td style="text-align: right; font-weight: 600;">${issues?.debt?.legacyDeadLinksCount ?? 0}</td>
            </tr>
            <tr>
              <td>Réunions brutes antérieures au seed sans page or</td>
              <td style="text-align: right; font-weight: 600;">${issues?.debt?.preSeedBronzeMeetingsWithoutGoldCount ?? 0}</td>
            </tr>
            <tr>
              <td>Articles bruts antérieurs au seed sans page or</td>
              <td style="text-align: right; font-weight: 600;">${issues?.debt?.preSeedBronzeArticlesWithoutGoldCount ?? 0}</td>
            </tr>
            <tr>
              <td>Autres bruts antérieurs au seed sans page or</td>
              <td style="text-align: right; font-weight: 600;">${issues?.debt?.preSeedBronzeOthersWithoutGoldCount ?? 0}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <!-- 4. Etats locaux a la machine (R12, R13) -->
    <div class="section-header">
      <h2 class="section-title"><span class="section-num">03 //</span><span>États locaux à la machine</span></h2>
      <span class="section-subtitle">Processus, verrous et caches locaux à cette station de travail</span>
    </div>
    <div class="local-badge">PORTÉE : MACHINE LOCALE (NON SYNCHRONISÉ)</div>
    <div class="dashboard-grid">
      <div class="card">
        <div class="card-title">Circuit Plaud & Synchronisation</div>
        <table class="data-table">
          <tbody>
            <tr>
              <td>File d'ingestion (.queue.json)</td>
              <td class="cell-right">
                <span class="status-badge ${localState?.queue?.status === 'present' ? 'status-pending' : 'status-local'}">
                  ${localState?.queue?.status === 'unknown' ? 'Non initialisé' : localState?.queue?.status === 'corrupt' ? 'Fichier corrompu' : localState?.queue?.status === 'empty' ? 'Vide (0)' : `${localState?.queue?.count} fichiers`}
                </span>
              </td>
            </tr>
            <tr>
              <td>Photo du bronze (.snapshot.json)</td>
              <td class="cell-right">
                <span class="status-badge status-local">
                  ${localState?.snapshot?.status === 'present' ? `Présent (${localState?.snapshot?.counts?.[domain] ?? 0} ${domain})` : 'Inconnu'}
                </span>
              </td>
            </tr>
            <tr>
              <td>Verrou du lanceur (.lock.json)</td>
              <td class="cell-right">
                <span class="status-badge ${localState?.lock?.status === 'active' ? 'status-ok' : 'status-local'}">
                  ${localState?.lock?.status === 'active' ? `Actif (PID ${localState?.lock?.pid})` : localState?.lock?.status === 'stale' ? 'Obsolète' : 'Inactif'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Entrant non classé (inbox/)</div>
        <table class="data-table">
          <tbody>
            <tr>
              <td>À trancher (inbox/a-trancher/)</td>
              <td class="cell-right">
                <span class="status-badge ${localState?.inboxArbitration?.status === 'present' ? 'status-held' : 'status-local'}">
                  ${localState?.inboxArbitration?.status === 'unknown' ? 'Absent' : localState?.inboxArbitration?.status === 'empty' ? 'Vide (0)' : `${localState?.inboxArbitration?.count} à arbitrer`}
                </span>
              </td>
            </tr>
            <tr>
              <td>Entrant brut en attente (inbox/)</td>
              <td class="cell-right">
                <span class="status-badge status-local">
                  ${localState?.inboxRaw?.status === 'unknown' ? 'Absent' : localState?.inboxRaw?.status === 'empty' ? 'Vide (0)' : `${localState?.inboxRaw?.count} fichiers`}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- Onglet 2 : Graphe 3D -->
  <div id="tab-graph" class="tab-content">
    <div class="graph-controls">
      <div class="graph-search-row">
        <input type="text" id="graph-search" class="graph-search-input" placeholder="Filtrer les nœuds..." oninput="handleSearch(this.value)" />
        <label class="graph-toggle-label" title="Afficher uniquement les voisins directs du nœud sélectionné">
          <input type="checkbox" id="include-neighbors" onchange="toggle1Hop(this.checked)" />
          <span>Voisinage direct</span>
        </label>
      </div>
      <div id="folder-filters" class="folder-toggles"></div>
      <div class="graph-toolbar-row">
        <span id="node-count-label" class="node-count-label">${(topology?.nodes?.filter(n => !n.phantom) ?? topology?.nodes)?.length ?? 0} nœuds</span>
        <div class="graph-btn-group">
          <button id="btn-toggle-2d" class="graph-btn" onclick="toggle2D()" title="Basculer entre vue 2D et 3D">2D / 3D</button>
          <button class="graph-btn" onclick="zoomIn()" title="Zoom avant" aria-label="Zoom avant">＋</button>
          <button class="graph-btn" onclick="zoomOut()" title="Zoom arrière" aria-label="Zoom arrière">－</button>
          <button class="graph-btn" onclick="resetGraphView()" title="Ajuster la vue">Recadrer</button>
          <button id="btn-reset-filters" class="graph-btn" onclick="resetAllFilters()" title="Réinitialiser filtres et sélection">Réinitialiser</button>
        </div>
      </div>
    </div>

    <!-- Conteneur 3D -->
    <div id="graph-container"></div>

    <!-- Panneau lateral de lecture -->
    <aside id="reader-panel">
      <div class="reader-header">
        <div class="reader-title-area">
          <div id="reader-title" class="reader-title">Titre du document</div>
          <div id="reader-meta" class="reader-meta"></div>
        </div>
        <div class="reader-actions">
          <button class="copy-pill-btn btn-standalone" id="focus-cam-btn" onclick="recenterOnActiveNode()" title="Recentrer la caméra sur ce nœud">Centrer</button>
          <button class="close-reader-btn" onclick="closeReaderPanel()" title="Fermer le panneau" aria-label="Fermer le panneau">✕</button>
        </div>
      </div>
      <div id="reader-body" class="reader-body markdown-content"></div>
    </aside>
  </div>

  <!-- Onglet 3 : Mode d'emploi de la KB -->
  <main id="tab-guide" class="tab-content">
    <div class="guide-hero">
      <div class="guide-kicker"><span class="jp" lang="ja" aria-hidden="true">書</span><span>Manuel du coffre</span></div>
      <h1>Mode d'emploi de Kioku</h1>
      <p>
        Ce coffre applique le modèle <strong>LLM Wiki de Karpathy</strong> (sources brutes, wiki structuré maintenu par Claude, schéma vivant)
        avec deux garanties architecturales majeures : une <strong>architecture médaillon</strong> (bronze → argent → or) et un <strong>silo strict pro / perso</strong>
        tenu par le hook de garde du plugin Kioku.
      </p>
    </div>

    <!-- Video de presentation (rendue par motion-studio, source : tools/dashboard/video/) -->
    <figure class="guide-video">
      <video controls preload="metadata" playsinline>
        <source src="vendor/media/kioku-explainer.mp4" type="video/mp4" />
        <track kind="subtitles" src="vendor/media/kioku-explainer.vtt" srclang="fr" label="Français" />
        La vidéo de présentation n'est pas disponible dans ce navigateur.
      </video>
      <figcaption>Kioku en 3 min : à quoi sert le coffre, puis comment il fonctionne.</figcaption>
    </figure>

    <!-- 1. Architecture Medaillon -->
    <h2 class="section-title"><span class="section-num">01.</span><span>Architecture Médaillon : Cycle de vie d'une connaissance</span></h2>
    <div class="medallion-pipeline">
      <!-- Bronze -->
      <div class="layer-card bronze">
        <span class="layer-badge layer-badge-bronze">1. Bronze • Immuable</span>
        <h3>raw/${domain}/</h3>
        <p>La source telle qu'elle est entrée : enregistrements bruts Plaud, transcriptions, notes de réunions, articles, PDFs.</p>
        <div class="layer-details">
          <strong>Règle d'or :</strong> Le bronze est strictement immuable. On ne le modifie jamais. Seule l'ingestion y accède en lecture.
        </div>
      </div>

      <!-- Argent -->
      <div class="layer-card silver">
        <span class="layer-badge layer-badge-silver">2. Argent • Nettoyé</span>
        <h3>silver/${domain}/</h3>
        <p>Une fiche synthétique par source brute : faits extraits, locuteurs résolus avec drapeaux d'incertitude, nettoyage des propos subjectifs.</p>
        <div class="layer-details">
          <strong>Règle d'or :</strong> L'argent isole les faits tangibles avant toute dissémination dans le wiki. Pointeur en quarantaine si contenu sensible.
        </div>
      </div>

      <!-- Or -->
      <div class="layer-card gold">
        <span class="layer-badge layer-badge-gold">3. Or • Wiki vivant</span>
        <h3>wiki/${domain}/</h3>
        <p>Le graphe de connaissances vivant : personnes, projets, réunions, décisions, concepts, synthèses. <em>C'est ici qu'on requête.</em></p>
        <div class="layer-details">
          <strong>Règle d'or :</strong> On n'écrit jamais directement dans l'or. Toute modification passe par <code>.candidats/</code> et la gate.
        </div>
      </div>

      <!-- Quarantaine -->
      <div class="layer-card quarantine">
        <span class="layer-badge layer-badge-gate">Arbitrage • En retenue</span>
        <h3>quarantine/${domain}/</h3>
        <p>Ce que la gate a retenu (propos non attribués, portraits, secrets). Attend une décision explicite de l'utilisateur.</p>
        <div class="layer-details">
          <strong>Commandes :</strong> Décider avec <code>kioku decide ${domain} &lt;id&gt; drop|keep</code>.
        </div>
      </div>
    </div>

    <!-- 2. Commandes au quotidien -->
    <h2 class="section-title"><span class="section-num">02.</span><span>Commandes et compétences au quotidien</span></h2>
    <div class="command-grid">
      <div class="command-card">
        <h3>Démarrer une session Claude</h3>
        <p>Ouvre une session avec les variables de domaine et de garde appropriées.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run ${domain}</span>
          <button class="copy-pill-btn" data-cmd="npm run ${domain}" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Interroger la base (/query)</h3>
        <p>Consulte l'index, navigue dans les fiches de l'or et formule une réponse avec citations sourcées.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">/query Quels sont les projets en cours ?</span>
          <button class="copy-pill-btn" data-cmd="/query Quels sont les projets en cours ?" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Converser depuis le dashboard (onglet 問 Question)</h3>
        <p>La même chose que /query, dans le navigateur : chaque tour lance une session Claude Code sous la garde, en mode query sur le domaine du serveur. Questions de suivi possibles ; fil éphémère. Demande le serveur local.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run dashboard:serve:${domain}</span>
          <button class="copy-pill-btn" data-cmd="npm run dashboard:serve:${domain}" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Ingérer une source brute (/ingest)</h3>
        <p>Enchaîne la lecture du bronze, la fiche argent, les candidates or, et le passage de la gate.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run ingest:${domain}</span>
          <button class="copy-pill-btn" data-cmd="npm run ingest:${domain}" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Auditer la qualité du coffre (/lint)</h3>
        <p>Contrôle les liens orphelins, anomalies de schéma et pages à décider.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run audit:${domain}</span>
          <button class="copy-pill-btn" data-cmd="npm run audit:${domain}" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Synchronisation Plaud (plaud:sync)</h3>
        <p>Dépose les notes Plaud dans l'inbox, les trie et lance l'ingestion dans le bon domaine.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run plaud:sync</span>
          <button class="copy-pill-btn" data-cmd="npm run plaud:sync" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>

      <div class="command-card">
        <h3>Serveur en direct (dashboard:serve)</h3>
        <p>Lance le serveur local à routes fixes avec surveillance native et notification live reload.</p>
        <div class="cli-pill">
          <span class="cli-pill-code">npm run dashboard:serve:${domain}</span>
          <button class="copy-pill-btn" data-cmd="npm run dashboard:serve:${domain}" onclick="copyCmd(this)">Copier</button>
        </div>
      </div>
    </div>

    <!-- 3. Regles de la Gate -->
    <h2 class="section-title"><span class="section-num">03.</span><span>Règles d'admission de la Gate (§9 de CLAUDE.md)</span></h2>
    <div class="rule-box">
      <strong>La frontière : Portrait vs Retour de travail</strong>
      <p>
        Une page admise dans l'or ne contient aucune insulte, diffamation, portrait subjectif ou donnée sensible.
        Les <strong>retours de travail attribués et datés</strong> (portant sur la conduite professionnelle ou les résultats) sont admis pour préparer les points d'équipe et 1to1.
      </p>
    </div>
  </main>

  <!-- Onglet 問 Question : chaque tour passe par /query dans une session Claude Code sous la garde -->
  <main id="tab-question" class="tab-content" aria-labelledby="question-title">
    <div class="question-intro">
      <span class="jp question-kanji" lang="ja" aria-hidden="true">問</span>
      <div>
        <h1 id="question-title">Interroger l'or · domaine ${domain}</h1>
        <p>Chaque question passe par /query dans une session Claude Code, sous la garde. Fil éphémère : recharger ouvre un nouveau fil.</p>
      </div>
    </div>

    <div id="question-offline" class="question-offline">
      <p>La conversation demande le serveur local du dashboard. Lance-le, puis ouvre l'adresse qu'il affiche :</p>
      <code>npm run dashboard:serve:${domain}</code>
    </div>

    <div id="question-live" hidden>
      <div class="question-meta">
        <span id="question-turns">aucun tour</span>
        <button id="question-new" class="question-link" type="button">↺ nouveau fil</button>
      </div>
      <div id="question-empty" class="question-empty">
        <p>Pose une question au wiki ${domain}.</p>
        <div class="question-examples">
          ${(isPro
            ? ['Quelles décisions ont été prises ce mois-ci ?', 'Où en sont les projets en cours ?', 'Quels sujets restent ouverts ?']
            : ['Quelles démarches sont en cours ?', 'Que reste-t-il à faire ce mois-ci ?'])
            .map((q) => `<button type="button" class="question-example" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
            .join('\n          ')}
        </div>
      </div>
      <div id="question-thread"></div>
      <div id="question-status" class="sr-only" aria-live="polite"></div>
    </div>

    <div id="question-composer" class="question-composer" hidden>
      <div class="question-composer-row">
        <div class="question-field">
          <label for="question-input" class="sr-only">Question au wiki ${domain}</label>
          <textarea id="question-input" rows="1" placeholder="Pose une question au wiki ${domain}…"></textarea>
          <button id="question-send" class="question-send" type="button">Envoyer ↵</button>
          <button id="question-stop" class="question-send" type="button" hidden>Interrompre</button>
        </div>
      </div>
      <div class="question-hint">
        <span>Entrée pour envoyer · Maj+Entrée = nouvelle ligne · Échap interrompt</span>
        <span>session : query / ${domain}</span>
      </div>
    </div>
  </main>

  <!-- Modale Palette de recherche globale (« / ») (KTD4, R9) -->
  <div id="search-palette" class="search-palette-modal" style="display: none;">
    <div class="search-palette-backdrop" onclick="closeSearchPalette()"></div>
    <div class="search-palette-window" role="dialog" aria-modal="true" aria-label="Recherche globale">
      <div class="search-palette-header">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="text" id="search-palette-input" class="search-palette-input" placeholder="Rechercher par titre, slug ou alias... (Échap pour fermer)" autocomplete="off" />
        <kbd class="kbd-key" onclick="closeSearchPalette()">Échap</kbd>
      </div>
      <div id="search-palette-results" class="search-palette-results">
        <div class="search-palette-hint">
          Tapez au moins 2 caractères pour rechercher parmi les pages du coffre.
        </div>
      </div>
      <div class="search-palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
        <span><kbd>↵</kbd> ouvrir</span>
        <span><kbd>Échap</kbd> fermer</span>
      </div>
    </div>
  </div>

  <!-- Donnees du domaine injectees en JSON -->
  <script id="vault-data" type="application/json">
${JSON.stringify({
  domain,
  generatedAt,
  mode,
  version,
  askToken,
  topology,
}).replace(/</g, '\\u003c')}
  </script>

  <!-- Bibliotheque 3D Force Graph (build UMD local) -->
  <script src="vendor/3d-force-graph.min.js"></script>

  <!-- Script d'interactivite client (compatible file://, zero reseau externe) -->
  <script>
    let rawData = null;
    let graphInstance = null;
    let selectedNode = null;
    let focusedNodeId = null;
    let visibleFolders = new Set();
    let is1HopActive = false;
    let is2D = false;
    let searchSelectedIndex = -1;
    let previouslyFocusedElement = null;

    // Ordre des puces de dossier ; les couleurs viennent des tokens CSS (KTD4)
    const FOLDERS = ['people', 'projects', 'meetings', 'sources', 'concepts', 'decisions', 'organizations', 'syntheses', 'phantom'];
    let graphPalette = { bg: '', paper: '', link: '', linkRest: '', focus: '' };
    let folderColors = {};

    // Lit les couleurs du graphe dans les tokens CSS (KTD4)
    function readGraphPalette() {
      const css = getComputedStyle(document.documentElement);
      const token = (name) => css.getPropertyValue('--' + name).trim();
      folderColors = {};
      FOLDERS.forEach(f => { folderColors[f] = token('folder-' + f); });
      graphPalette = {
        bg: token('graph-scene') || token('graph-bg'),
        paper: token('graph-bg'),
        link: token('graph-link'),
        linkRest: token('graph-link-rest') || token('graph-link'),
        focus: token('graph-focus')
      };
      return graphPalette;
    }

    function nodeColorFor(n) {
      return n.phantom ? folderColors.phantom : (folderColors[n.folder] || folderColors.organizations);
    }

    // Lavis : la couleur du dossier fondue dans le papier. Au repos, pigments pleins (en
    // lavis, huit dossiers sourds se confondaient) ; le lavis met en retrait le reste du
    // graphe quand un noeud est selectionne.
    const WASH = 0.45; // 0,62 virait au gris : la teinte doit rester lisible en retrait
    // Sans expression reguliere : ce script vit dans une chaine template, ou les
    // antislashs seraient consommes a la generation.
    function parseCssColor(c) {
      c = (c || '').trim();
      if (c.charAt(0) === '#' && c.length === 7) {
        return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).concat(1);
      }
      if (c.indexOf('rgb') === 0) {
        const v = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).split(',').map(Number);
        if (v.length >= 3 && v.every(x => !isNaN(x))) return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
      }
      return null;
    }
    function washOf(color) {
      const c = parseCssColor(color), p = parseCssColor(graphPalette.paper);
      if (!c || !p) return color;
      const mix = (i) => Math.round(c[i] + (p[i] - c[i]) * WASH);
      return 'rgba(' + mix(0) + ', ' + mix(1) + ', ' + mix(2) + ', ' + c[3] + ')';
    }

    // Taille : nombre de pages qui citent le noeud (backlinks ; le champ linksCount n'est
    // jamais calcule par la lecture du coffre). val est un volume pour 3d-force-graph
    // (rayon = racine cubique) : on fixe le rayon, croissance logarithmique et moderee.
    // Calibre sur le coffre pro (mediane ~9 citations) : la page mediane garde la taille
    // d'avant (val ~4), une page sans citation est ~2x plus petite, la plus citee ~2x plus grande.
    function nodeValFor(n) {
      if (n.phantom) return 1;
      const r = 1 + 0.3 * Math.log2(1 + (n.backlinks || []).length);
      return 0.5 * r * r * r;
    }

    // Couleur pleine : tout le graphe au repos et en recherche ; avec une selection,
    // seulement le noeud selectionne et ses voisins.
    const POSITION_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
    let highlightIds = null;
    let searchActive = false;
    function isLit(n) {
      return highlightIds ? highlightIds.has(n.id) : true;
    }

    function isFocusLink(link) {
      const sId = typeof link.source === 'object' ? link.source.id : link.source;
      const tId = typeof link.target === 'object' ? link.target.id : link.target;
      return sId === focusedNodeId || tId === focusedNodeId;
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function initData() {
      const dataScript = document.getElementById('vault-data');
      if (dataScript) {
        try {
          rawData = JSON.parse(dataScript.textContent);
        } catch (e) {
          console.error('Erreur de parsing des donnees du vault', e);
        }
      }
    }

    function initSyncIndicator() {
      const isFile = window.location.protocol === 'file:';
      const indicator = document.getElementById('sync-indicator');
      if (!indicator || isFile || !rawData || rawData.mode !== 'live' || !rawData.generatedAt) return;

      const genTime = new Date(rawData.generatedAt).getTime();
      function updateSync() {
        const diffSec = Math.max(0, Math.round((Date.now() - genTime) / 1000));
        if (diffSec < 60) {
          indicator.textContent = 'Synchronisé il y a ' + diffSec + 's';
        } else {
          const diffMin = Math.floor(diffSec / 60);
          indicator.textContent = 'Synchronisé il y a ' + diffMin + 'm';
        }
      }
      updateSync();
      setInterval(updateSync, 1000);
    }

    function initLiveUpdates() {
      const isFile = window.location.protocol === 'file:';
      if (isFile || !rawData || rawData.mode !== 'live') return;

      const initialVersion = typeof rawData.version === 'number' ? rawData.version : 0;
      const banner = document.getElementById('update-banner');
      const bannerText = document.getElementById('update-banner-text');
      if (!banner || !bannerText) return;

      let bannerUpdateTimer = null;
      let changeDetectedTime = null;

      function showBanner() {
        if (!changeDetectedTime) {
          changeDetectedTime = Date.now();
        }
        banner.style.display = 'block';

        if (!bannerUpdateTimer) {
          const updateText = () => {
            const diffSec = Math.max(0, Math.round((Date.now() - changeDetectedTime) / 1000));
            if (diffSec < 60) {
              bannerText.textContent = 'Le coffre a été modifié il y a ' + diffSec + 's.';
            } else {
              const diffMin = Math.floor(diffSec / 60);
              bannerText.textContent = 'Le coffre a été modifié il y a ' + diffMin + 'm.';
            }
          };
          updateText();
          bannerUpdateTimer = setInterval(updateText, 1000);
        }
      }

      try {
        const es = new EventSource('/events');
        let firstBoot = null;
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Un autre boot = serveur redemarre. Sous node --watch (dev) on recharge ; la route
            // du hash garde la page affichee. Sinon, bandeau : jamais de rechargement seul.
            if (data.boot !== undefined) {
              if (firstBoot === null) firstBoot = data.boot;
              else if (data.boot !== firstBoot) {
                if (data.dev === true) {
                  window.location.reload();
                  return;
                }
                showBanner();
              }
            }
            if (typeof data.version === 'number' && data.version > initialVersion) {
              showBanner();
            }
          } catch {
            // ignore
          }
        };
        es.onerror = () => {
          // Laisse EventSource retenter en silence sans lever de faux bandeau
        };
      } catch {
        // ignore
      }
    }

    // Onglet 問 Question. La page n'interprete rien : elle relaie a /ask, affiche le texte brut au fil
    // de l'eau (textContent), puis le HTML rendu et echappe par le serveur (markdown.mjs) a la fin.
    // Le fil vit en memoire de page : recharger ou « nouveau fil » repart a vierge (R4).
    const QUESTION_MESSAGES = {
      busy: 'Une réponse est déjà en cours, dans cet onglet ou un autre.',
      token: 'Le serveur a redémarré : recharge la page.',
      spawn: 'Session impossible : vérifie l’installation de Claude Code.',
      'no-guard': 'Session refusée : la garde du coffre n’est pas en place (lance kioku doctor --live).',
      session: 'La session a échoué ; repose la question.',
    };
    // Attente du premier mot : phrases japonaises ecrites caractere par caractere, jamais sans leur
    // traduction (les kanji de la DA ne sont jamais seuls).
    const WAITING_PHRASES = [
      ['索引を読んでいます', 'lecture de l’index'],
      ['頁をめくっています', 'les pages se tournent'],
      ['記憶をたどっています', 'la mémoire se déroule'],
      ['言葉を選んでいます', 'les mots se choisissent'],
    ];

    function initQuestion() {
      const offline = document.getElementById('question-offline');
      const liveBox = document.getElementById('question-live');
      const composer = document.getElementById('question-composer');
      const input = document.getElementById('question-input');
      const sendBtn = document.getElementById('question-send');
      const stopBtn = document.getElementById('question-stop');
      const newBtn = document.getElementById('question-new');
      const threadBox = document.getElementById('question-thread');
      const emptyBox = document.getElementById('question-empty');
      const turnsLabel = document.getElementById('question-turns');
      const status = document.getElementById('question-status');
      if (!offline || !liveBox || !composer || !input) return;

      const token = rawData && rawData.askToken;
      const isLive = window.location.protocol !== 'file:' && rawData && rawData.mode === 'live' && typeof token === 'string' && token.length > 0;
      if (!isLive) return; // file:// ou rendu statique : le panneau d'explication reste seul, aucune requete

      offline.hidden = true;
      liveBox.hidden = false;
      composer.hidden = false;

      const NL = String.fromCharCode(10);
      let thread = null;
      let turns = 0;
      let controller = null;
      let busy = false;

      function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function hhmm() {
        return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      }
      function atBottom() {
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      }
      function follow(wasAtBottom) {
        if (wasAtBottom) window.scrollTo(0, document.body.scrollHeight);
      }
      function setTurns() {
        turnsLabel.textContent = turns === 0 ? 'aucun tour' : 'fil en cours · ' + turns + (turns > 1 ? ' tours' : ' tour');
      }
      function setBusy(value) {
        busy = value;
        input.disabled = value;
        sendBtn.hidden = value;
        stopBtn.hidden = !value;
        newBtn.disabled = value;
        threadBox.setAttribute('aria-busy', value ? 'true' : 'false');
      }

      function appendTurn(question) {
        const stick = atBottom();
        const turn = el('div', 'question-turn');
        const ask = el('div', 'question-ask');
        ask.appendChild(el('span', 'question-who', 'toi · ' + hhmm()));
        ask.appendChild(document.createTextNode(question));
        const answer = el('div', 'question-answer');
        const who = el('span', 'question-who', 'kioku · en cours…');
        const trace = el('div', 'question-trace', 'recherche dans l’index…');
        const waiting = el('div', 'question-waiting');
        const waitJp = el('span', 'jp question-waiting-jp');
        waitJp.setAttribute('lang', 'ja');
        waitJp.setAttribute('aria-hidden', 'true');
        const waitFr = el('span', 'question-waiting-fr');
        waiting.appendChild(waitJp);
        waiting.appendChild(waitFr);
        const stream = el('div', 'question-stream is-writing');
        const body = el('div', 'question-body');
        answer.appendChild(who);
        answer.appendChild(trace);
        answer.appendChild(waiting);
        answer.appendChild(stream);
        answer.appendChild(body);
        turn.appendChild(ask);
        turn.appendChild(answer);
        threadBox.appendChild(turn);
        follow(stick);
        const t = { who: who, trace: trace, waiting: waiting, waitJp: waitJp, waitFr: waitFr, waitTimer: null, stream: stream, body: body, answer: answer, pages: [] };
        startWaiting(t);
        return t;
      }

      // Machine a ecrire : ecrit la phrase, la laisse un instant, l'efface, passe a la suivante.
      function startWaiting(t) {
        let p = 0;
        let i = 0;
        let dir = 1;
        let pause = 0;
        t.waitFr.textContent = WAITING_PHRASES[0][1];
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) {
          t.waitJp.textContent = WAITING_PHRASES[0][0];
          return;
        }
        t.waitTimer = setInterval(function () {
          if (pause > 0) { pause -= 1; return; }
          const phrase = WAITING_PHRASES[p][0];
          i += dir;
          t.waitJp.textContent = phrase.slice(0, i);
          if (dir === 1 && i >= phrase.length) {
            dir = -1;
            pause = 16;
          } else if (dir === -1 && i <= 0) {
            dir = 1;
            p = (p + 1) % WAITING_PHRASES.length;
            t.waitFr.textContent = WAITING_PHRASES[p][1];
            pause = 3;
          }
        }, 140);
      }

      function stopWaiting(t) {
        if (t.waitTimer) clearInterval(t.waitTimer);
        t.waitTimer = null;
        if (t.waiting && t.waiting.parentNode) t.waiting.remove();
      }

      function addRead(t, page) {
        if (t.pages.indexOf(page) !== -1) return;
        t.pages.push(page);
        t.trace.textContent = '';
        t.pages.forEach(function (p, i) {
          if (i > 0) t.trace.appendChild(document.createTextNode(' · '));
          t.trace.appendChild(document.createTextNode('lit '));
          t.trace.appendChild(el('b', null, p));
        });
      }

      function restore(question) {
        if (!input.value.trim()) input.value = question;
        autosize();
      }

      function endWithState(t, question, text, interrupted) {
        stopWaiting(t);
        t.stream.classList.remove('is-writing');
        if (!t.stream.textContent) t.stream.remove();
        if (!t.pages.length) t.trace.remove();
        t.who.textContent = 'kioku · ' + hhmm() + (interrupted ? ' · incomplet' : '');
        t.answer.appendChild(el('div', 'question-state', text));
        thread = null; // le serveur a efface le fil : le tour suivant repart a neuf
        restore(question);
        status.textContent = text;
      }

      function finish(t, evt) {
        const stick = atBottom();
        stopWaiting(t);
        t.stream.remove();
        if (!t.pages.length) t.trace.remove();
        t.body.innerHTML = evt.html; // HTML rendu et echappe par le serveur (renderMarkdown)
        const seconds = Math.max(1, Math.round((evt.durationMs || 0) / 1000));
        const pages = evt.pagesRead || 0;
        t.who.textContent = 'kioku · ' + hhmm() + ' · ' + seconds + ' s · ' + pages + (pages > 1 ? ' pages lues' : ' page lue');
        thread = evt.thread || null;
        turns += 1;
        setTurns();
        status.textContent = 'Réponse terminée.';
        follow(stick);
      }

      async function send() {
        const question = input.value.trim();
        if (!question || busy) return;
        input.value = '';
        autosize();
        emptyBox.hidden = true;
        setBusy(true);
        status.textContent = 'Réponse en cours…';
        const t = appendTurn(question);
        controller = new AbortController();
        let final = false;
        try {
          const res = await fetch('/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Kioku-Token': token },
            body: JSON.stringify({ question: question, thread: thread }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const code = res.status === 409 ? 'busy' : res.status === 403 ? 'token' : 'session';
            endWithState(t, question, QUESTION_MESSAGES[code], false);
            final = true;
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf(NL)) !== -1) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line) continue;
              let evt;
              try { evt = JSON.parse(line); } catch (_) { continue; }
              if (evt.type === 'read') {
                addRead(t, evt.path);
              } else if (evt.type === 'text') {
                const stick = atBottom();
                stopWaiting(t);
                t.stream.textContent += evt.text;
                follow(stick);
              } else if (evt.type === 'done') {
                finish(t, evt);
                final = true;
              } else if (evt.type === 'cancelled') {
                endWithState(t, question, 'Interrompu.', true);
                final = true;
              } else if (evt.type === 'error') {
                endWithState(t, question, QUESTION_MESSAGES[evt.code] || QUESTION_MESSAGES.session, false);
                final = true;
              }
            }
          }
          if (!final) endWithState(t, question, QUESTION_MESSAGES.session, true);
        } catch (err) {
          if (!final) {
            if (err && err.name === 'AbortError') endWithState(t, question, 'Interrompu.', true);
            else endWithState(t, question, QUESTION_MESSAGES.session, true);
          }
        } finally {
          controller = null;
          setBusy(false);
          input.focus();
        }
      }

      function interrupt() {
        if (busy && controller) controller.abort();
      }

      // Le champ grandit avec le texte (plafond fixe par max-height)
      function autosize() {
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
      }
      input.addEventListener('input', autosize);

      sendBtn.addEventListener('click', send);
      stopBtn.addEventListener('click', interrupt);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
      document.addEventListener('keydown', function (e) {
        const tab = document.getElementById('tab-question');
        if (e.key === 'Escape' && busy && tab && tab.classList.contains('active')) interrupt();
      });
      newBtn.addEventListener('click', function () {
        if (busy) return;
        thread = null;
        turns = 0;
        setTurns();
        threadBox.textContent = '';
        emptyBox.hidden = false;
        input.focus();
      });
      document.querySelectorAll('.question-example').forEach(function (btn) {
        btn.addEventListener('click', function () {
          input.value = btn.getAttribute('data-question') || '';
          autosize();
          input.focus();
        });
      });
    }

    // Routes dans le hash (fonctionnent aussi en file://) : #/pilote, #/graphe, #/guide,
    // #/page/<dossier>/<slug>. Precedent / Suivant, favoris et rechargement gardent la page.
    const ROUTE_TO_TAB = { pilote: 'pilot', graphe: 'graph', guide: 'guide', question: 'question' };
    const TAB_TO_ROUTE = { pilot: 'pilote', graph: 'graphe', guide: 'guide', question: 'question' };
    let applyingRoute = false;

    function setRoute(route) {
      if (applyingRoute) return;
      const hash = '#/' + route;
      if (window.location.hash !== hash) history.pushState(null, '', hash);
    }

    function applyRoute() {
      let h = window.location.hash || '';
      if (h.charAt(0) === '#') h = h.slice(1);
      if (h.charAt(0) === '/') h = h.slice(1);
      // decodeURIComponent : accepte aussi l'ancien format #page/people%2Falice (markdown.mjs)
      try { h = decodeURIComponent(h); } catch (_) {}
      applyingRoute = true;
      try {
        if (h.indexOf('page/') === 0) focusNodeInGraph(h.slice(5));
        else switchTab(ROUTE_TO_TAB[h] || 'pilot');
      } finally {
        applyingRoute = false;
      }
    }
    window.addEventListener('hashchange', applyRoute);

    // Le rendu WebGL tourne en continu : on le suspend hors de l'onglet graphe ou page cachee
    // (CPU/GPU, et Safari recharge un onglet qui consomme trop).
    function syncGraphAnimation() {
      if (!graphInstance) return;
      const shown = !document.hidden && document.getElementById('tab-graph')?.classList.contains('active');
      if (shown) graphInstance.resumeAnimation();
      else graphInstance.pauseAnimation();
    }
    document.addEventListener('visibilitychange', syncGraphAnimation);

    function switchTab(tabId) {
      setRoute(TAB_TO_ROUTE[tabId] || tabId);
      document.querySelectorAll('.tab-btn, #btn-guide').forEach(btn => {
        btn.classList.remove('active');
        btn.removeAttribute('aria-current');
      });
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      const activeBtn = document.getElementById('btn-' + tabId);
      const activeContent = document.getElementById('tab-' + tabId);
      if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.setAttribute('aria-current', 'page');
      }
      if (activeContent) activeContent.classList.add('active');
      syncGraphAnimation();

      if (tabId === 'graph') {
        if (!graphInstance) {
          initGraph();
        } else {
          const container = document.getElementById('graph-container');
          if (container) {
            graphInstance.width(container.clientWidth);
            graphInstance.height(container.clientHeight);
          }
        }
      }
    }

    function filterTriage(stage, btn) {
      document.querySelectorAll('.triage-filters .filter-pill').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.medallion-frise .pipeline-step').forEach(s => s.classList.remove('active'));

      if (btn && btn.classList.contains('filter-pill')) {
        btn.classList.add('active');
        const correspondingStep = document.querySelector('.medallion-frise .pipeline-step[data-filter-stage="' + stage + '"]');
        if (correspondingStep) correspondingStep.classList.add('active');
      } else if (btn && btn.classList.contains('pipeline-step')) {
        btn.classList.add('active');
        const correspondingPill = document.querySelector('.triage-filters .filter-pill[data-filter="' + stage + '"]');
        if (correspondingPill) correspondingPill.classList.add('active');
      }

      const items = document.querySelectorAll('.triage-item');
      let visibleCount = 0;

      items.forEach(item => {
        const itemStage = item.getAttribute('data-stage');
        if (stage === 'all' || itemStage === stage) {
          item.style.display = 'flex';
          visibleCount++;
        } else {
          item.style.display = 'none';
        }
      });

      const emptyNotice = document.getElementById('triage-empty-filtered');
      if (emptyNotice) {
        emptyNotice.style.display = visibleCount === 0 && items.length > 0 ? 'block' : 'none';
      }
    }

    function copyCmd(btn, maybeCmd) {
      const cmd = maybeCmd || (btn && btn.getAttribute('data-cmd')) || '';
      if (!cmd) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(() => {
          showCopyFeedback(btn, 'Copié !');
        }).catch(() => {
          fallbackCopy(cmd, btn);
        });
      } else {
        fallbackCopy(cmd, btn);
      }
    }

    function showCopyFeedback(btn, msg) {
      if (!btn) return;
      if (!btn.dataset.origText) {
        btn.dataset.origText = btn.textContent;
      }
      if (btn._copyTimeout) {
        clearTimeout(btn._copyTimeout);
      }
      btn.textContent = msg;
      btn.classList.add('copy-success');
      const announcer = document.getElementById('sr-announcer');
      if (announcer) {
        announcer.textContent = 'Commande copiée : ' + (btn.getAttribute('data-cmd') || msg);
      }
      btn._copyTimeout = setTimeout(() => {
        btn.textContent = btn.dataset.origText || 'Copier';
        delete btn.dataset.origText;
        btn._copyTimeout = null;
        btn.classList.remove('copy-success');
      }, 1500);
    }

    function fallbackCopy(text, btn) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showCopyFeedback(btn, 'Copié !');
      } catch {
        showCopyFeedback(btn, 'Échec copie');
      }
      document.body.removeChild(ta);
    }

    /* Palette de recherche globale (KTD4, R9) */
    function openSearchPalette() {
      previouslyFocusedElement = document.activeElement;
      const modal = document.getElementById('search-palette');
      const input = document.getElementById('search-palette-input');
      if (!modal || !input) return;

      modal.style.display = 'flex';
      input.value = '';
      searchSelectedIndex = -1;
      renderSearchResults([]);
      input.focus();
    }

    function closeSearchPalette() {
      const modal = document.getElementById('search-palette');
      if (!modal) return;
      modal.style.display = 'none';
      if (previouslyFocusedElement && typeof previouslyFocusedElement.focus === 'function') {
        previouslyFocusedElement.focus();
      }
    }

    function renderSearchResults(results) {
      const container = document.getElementById('search-palette-results');
      if (!container) return;

      if (!results || results.length === 0) {
        const inputVal = (document.getElementById('search-palette-input')?.value || '').trim();
        if (inputVal.length < 2) {
          container.innerHTML = '<div class="search-palette-hint">Tapez au moins 2 caractères pour rechercher.</div>';
        } else {
          container.innerHTML = '<div class="search-palette-hint">Aucun résultat</div>';
        }
        return;
      }

      let html = '';
      results.slice(0, 15).forEach((node, idx) => {
        const isSelected = idx === searchSelectedIndex ? ' selected' : '';
        const aliasesText = node.aliases && node.aliases.length > 0 ? ' <span class="search-palette-alias">[' + escapeHtml(node.aliases.join(', ')) + ']</span>' : '';
        html += '<div class="search-palette-item' + isSelected + '" data-node-id="' + escapeHtml(node.id) + '" onclick="selectSearchResult(this.dataset.nodeId)">';
        html += '  <span class="search-palette-item-title">' + escapeHtml(node.title || node.id) + aliasesText + '</span>';
        html += '  <span class="search-palette-folder">' + escapeHtml(node.folder) + '</span>';
        html += '</div>';
      });
      container.innerHTML = html;
    }

    function selectSearchResult(nodeId) {
      closeSearchPalette();
      switchTab('graph');
      focusNodeInGraph(nodeId);
    }

    // Gestion du champ de saisie de la palette
    document.addEventListener('DOMContentLoaded', () => {
      const pInput = document.getElementById('search-palette-input');
      if (pInput) {
        pInput.addEventListener('input', (e) => {
          const q = (e.target.value || '').toLowerCase().trim();
          if (q.length < 2 || !rawData?.topology?.nodes) {
            renderSearchResults([]);
            return;
          }

          const matches = rawData.topology.nodes.filter(n => {
            const titleMatch = (n.title || '').toLowerCase().includes(q);
            const slugMatch = (n.slug || '').toLowerCase().includes(q);
            const aliasMatch = (n.aliases || []).some(a => a.toLowerCase().includes(q));
            return titleMatch || slugMatch || aliasMatch;
          });

          // Tri par pertinence : exact match > prefix match > substring
          matches.sort((a, b) => {
            const aTitle = (a.title || '').toLowerCase();
            const bTitle = (b.title || '').toLowerCase();
            const aSlug = (a.slug || '').toLowerCase();
            const bSlug = (b.slug || '').toLowerCase();
            const aExact = aTitle === q || aSlug === q;
            const bExact = bTitle === q || bSlug === q;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            const aPrefix = aTitle.startsWith(q) || aSlug.startsWith(q);
            const bPrefix = bTitle.startsWith(q) || bSlug.startsWith(q);
            if (aPrefix && !bPrefix) return -1;
            if (!aPrefix && bPrefix) return 1;
            return 0;
          });

          searchSelectedIndex = matches.length > 0 ? 0 : -1;
          renderSearchResults(matches);
        });

        pInput.addEventListener('keydown', (e) => {
          const items = document.querySelectorAll('.search-palette-item');
          if (items.length === 0) return;

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            searchSelectedIndex = (searchSelectedIndex + 1) % items.length;
            updateSelectedSearchItem();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            searchSelectedIndex = (searchSelectedIndex - 1 + items.length) % items.length;
            updateSelectedSearchItem();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (searchSelectedIndex >= 0 && items[searchSelectedIndex]) {
              const id = items[searchSelectedIndex].getAttribute('data-node-id');
              if (id) selectSearchResult(id);
            }
          }
        });
      }
    });

    function updateSelectedSearchItem() {
      const items = document.querySelectorAll('.search-palette-item');
      items.forEach((it, idx) => {
        if (idx === searchSelectedIndex) {
          it.classList.add('selected');
          it.scrollIntoView({ block: 'nearest' });
        } else {
          it.classList.remove('selected');
        }
      });
    }

    // Ecouteur clavier global pour raccourci « / » et « Escape » (KTD4)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('search-palette');
        if (modal && modal.style.display !== 'none') {
          closeSearchPalette();
        }
        return;
      }

      if ((e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        const modal = document.getElementById('search-palette');
        if (modal && modal.style.display !== 'none') {
          return;
        }
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.isComposing) {
          return;
        }
        e.preventDefault();
        openSearchPalette();
      }
    });

    /* Graphe 3D et 2D interactif */
    function isWebGLAvailable() {
      try {
        const canvas = document.createElement('canvas');
        return Boolean(
          window.WebGLRenderingContext &&
          (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
        );
      } catch (_) {
        return false;
      }
    }

    function renderWebGLError(container, reason) {
      if (!container) return;
      container.innerHTML =
        '<div class="webgl-error">' +
          '<div class="webgl-error-sheet">' +
            '<h3>Accélération WebGL désactivée</h3>' +
            '<p>' +
              'Le rendu 3D nécessite l’accélération matérielle WebGL. Le navigateur a retourné :<br>' +
              '<code>' + escapeHtml(reason) + '</code>' +
            '</p>' +
            '<div class="webgl-error-help">' +
              '<p><strong>Comment activer WebGL dans Chrome / Brave :</strong></p>' +
              '<ol>' +
                '<li>Ouvrez <strong>chrome://settings/system</strong> dans votre navigateur.</li>' +
                '<li>Activez l’option <strong>« Utiliser l’accélération graphique si disponible »</strong>.</li>' +
                '<li>Cliquez sur <strong>« Relancer »</strong> pour redémarrer Chrome.</li>' +
                '<li>Revenez sur cette page : le graphe s’initialisera directement.</li>' +
              '</ol>' +
            '</div>' +
            '<button class="action-btn-primary" onclick="retryInitGraph()">Réessayer l’initialisation</button>' +
          '</div>' +
        '</div>';
    }

    function retryInitGraph() {
      const container = document.getElementById('graph-container');
      if (container) container.innerHTML = '';
      graphInstance = null;
      initGraph();
    }

    function initGraph() {
      const container = document.getElementById('graph-container');
      if (!container || !rawData?.topology) return;

      if (!isWebGLAvailable()) {
        renderWebGLError(container, 'Accélération matérielle WebGL désactivée (GL_VENDOR = Disabled)');
        return;
      }

      readGraphPalette();
      visibleFolders = new Set(FOLDERS.filter(f => f !== 'phantom'));

      // Puces de dossier : couleurs portees par le CSS (data-folder)
      const filterContainer = document.getElementById('folder-filters');
      if (filterContainer && filterContainer.children.length === 0) {
        FOLDERS.forEach(f => {
          const isPhantom = f === 'phantom';
          const tag = document.createElement('button');
          tag.type = 'button';
          tag.className = isPhantom ? 'folder-tag inactive' : 'folder-tag active';
          tag.setAttribute('data-folder', f);
          tag.textContent = isPhantom ? 'fantômes' : f;
          tag.onclick = () => toggleFolder(f, tag);
          filterContainer.appendChild(tag);
        });
      }
      syncFolderTags();

      const nodes = rawData.topology.nodes.map(n => ({
        ...n,
        color: nodeColorFor(n),
        val: nodeValFor(n)
      }));

      const links = rawData.topology.links.map(l => ({ ...l }));

      try {
        graphInstance = ForceGraph3D({ controlType: 'orbit' })(container)
          .graphData({ nodes, links })
          .backgroundColor(graphPalette.bg)
          .nodeLabel(d => {
            const escTitle = escapeHtml(d.title || d.id || '');
            if (d.id === focusedNodeId) return '⭐ ' + escTitle + ' [Actif]';
            let lbl = escTitle;
            if (d.phantom) lbl += ' (fantôme)';
            if (d.isNeighbor) lbl += ' [relié]';
            return lbl;
          })
          .nodeColor(d => {
            if (d.id === focusedNodeId) return graphPalette.focus;
            return isLit(d) ? d.color : washOf(d.color);
          })
          .nodeVal(d => {
            // Volume x2 => rayon x1,26 : le noeud se distingue par sa couleur, pas par sa masse
            if (d.id === focusedNodeId) return Math.max(4, (d.val || 2) * 2);
            return d.val;
          })
          .nodeResolution(24)
          .nodeOpacity(1)
          .linkOpacity(1)
          .linkWidth(link => {
            if (!focusedNodeId) return 0;
            // Trait d'encre fin : 1,6 donnait des tubes epais qui masquaient les noeuds
            return isFocusLink(link) ? 0.35 : 0;
          })
          .linkColor(link => {
            if (focusedNodeId && isFocusLink(link)) return graphPalette.focus;
            return searchActive && !focusedNodeId ? graphPalette.link : graphPalette.linkRest;
          })
          .onNodeClick(node => {
            focusedNodeId = node.id;
            setRoute('page/' + encodeURI(node.id));
            openReaderPanel(node);
            applyGraphFilters();
            centerCameraOnNode(node);
          })
          .onBackgroundClick(() => {
            if (is1HopActive) {
              // Ne pas desenclencher 1-hop brutalement
            }
          });

        // Noeuds mats, comme des gouttes de pigment sur le papier : on garde la seule lumiere
        // ambiante, en blanc et a l'intensite PI. Avec le materiau Lambert des noeuds, elle
        // restitue exactement la couleur du token, sans modele ni reflet ; la lumiere
        // directionnelle par defaut (qui donnait l'aspect de billes brillantes) est retiree.
        const ambient = (graphInstance.lights ? graphInstance.lights() : []).find(l => l.isAmbientLight);
        if (ambient) {
          ambient.color.setRGB(1, 1, 1);
          ambient.intensity = Math.PI;
          graphInstance.lights([ambient]);
        }

        // En fin de drag, 3d-force-graph envoie aux OrbitControls un pointerup synthetique
        // (pointerType touch, pointerId inconnu) alors que le pointeur reel de la souris est
        // encore enregistre : les controles le prennent pour un 2e doigt sans position et
        // levent "reading 'x'", ce qui laisse le drag accroche (curseur main, noeud qui suit).
        // On ignore ce pointerup synthetique ; le vrai pointerup fait le nettoyage.
        const navControls = graphInstance.controls();
        if (navControls && typeof navControls._onPointerUp === 'function') {
          const onPointerUp = navControls._onPointerUp;
          // Fonction flechee : le document appelle l'ecouteur avec this = document.
          navControls._onPointerUp = (e) => {
            const pointers = navControls._pointers;
            if (!e.isTrusted && Array.isArray(pointers) && !pointers.includes(e.pointerId)) return;
            return onPointerUp(e);
          };
        }

        // Pas de onNodeDrag / onNodeDragEnd : 3d-force-graph rechauffe la simulation pendant
        // le drag et libere le noeud a la fin. L'ancien code appelait graphInstance.d3AlphaTarget,
        // qui n'existe pas sur l'instance : l'exception, levee au milieu du dragend de la
        // bibliotheque, laissait les controles desactives et le noeud accroche a la souris.

        const canvas = container.querySelector('canvas');
        if (canvas) {
          canvas.addEventListener('pointerdown', (e) => {
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
          });
          canvas.addEventListener('pointerup', (e) => {
            try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
          });
        }
        window.addEventListener('pointerup', () => {
          // Relâchement sans injection d'événement synthétique
        });
        applyGraphFilters();
      } catch (err) {
        console.warn('Erreur lors de l’initialisation 3D Force Graph :', err);
        graphInstance = null;
        renderWebGLError(container, err.message || 'Erreur d’allocation du contexte WebGL');
      }
    }

    function toggle1Hop(active) {
      is1HopActive = Boolean(active);
      applyGraphFilters();
    }

    function toggle2D() {
      if (!graphInstance) return;
      is2D = !is2D;
      const btn = document.getElementById('btn-toggle-2d');
      if (btn) btn.textContent = is2D ? 'Mode 3D' : 'Mode 2D';

      graphInstance.numDimensions(is2D ? 2 : 3);
      if (is2D) {
        // Aligner la camera perpendiculairement au plan XY et desactiver la rotation (KTD3)
        const dist = 600;
        graphInstance.cameraPosition({ x: 0, y: 0, z: dist }, { x: 0, y: 0, z: 0 }, 400);
        const controls = graphInstance.controls();
        if (controls) {
          if ('enableRotate' in controls) controls.enableRotate = false;
          if ('noRotate' in controls) controls.noRotate = true;
        }
      } else {
        const controls = graphInstance.controls();
        if (controls) {
          if ('enableRotate' in controls) controls.enableRotate = true;
          if ('noRotate' in controls) controls.noRotate = false;
        }
        graphInstance.zoomToFit(400, 20);
      }
    }

    function zoomIn() {
      if (!graphInstance) return;
      const pos = graphInstance.cameraPosition();
      if (!pos) return;
      const factor = 0.75;
      const controls = graphInstance.controls ? graphInstance.controls() : null;
      const lookAt = is2D ? { x: pos.x * factor, y: pos.y * factor, z: 0 } : (controls?.target || { x: 0, y: 0, z: 0 });
      graphInstance.cameraPosition({ x: pos.x * factor, y: pos.y * factor, z: pos.z * factor }, lookAt, 250);
    }

    function zoomOut() {
      if (!graphInstance) return;
      const pos = graphInstance.cameraPosition();
      if (!pos) return;
      const factor = 1.33;
      const controls = graphInstance.controls ? graphInstance.controls() : null;
      const lookAt = is2D ? { x: pos.x * factor, y: pos.y * factor, z: 0 } : (controls?.target || { x: 0, y: 0, z: 0 });
      graphInstance.cameraPosition({ x: pos.x * factor, y: pos.y * factor, z: pos.z * factor }, lookAt, 250);
    }

    function resetGraphView() {
      if (!graphInstance) return;
      graphInstance.zoomToFit(400, 20);
    }

    function resetAllFilters() {
      focusedNodeId = null;
      is1HopActive = false;
      const hopCheck = document.getElementById('include-neighbors');
      if (hopCheck) hopCheck.checked = false;
      const sInput = document.getElementById('graph-search');
      if (sInput) sInput.value = '';
      visibleFolders = new Set(FOLDERS.filter(f => f !== 'phantom'));
      syncFolderTags();
      applyGraphFilters();
      resetGraphView();
      closeReaderPanel();
    }

    function syncFolderTags() {
      document.querySelectorAll('#folder-filters .folder-tag').forEach(t => {
        const visible = visibleFolders.has(t.getAttribute('data-folder'));
        t.classList.toggle('active', visible);
        t.classList.toggle('inactive', !visible);
      });
    }

    function toggleFolder(folder, tagElement) {
      const nowVisible = !visibleFolders.has(folder);
      if (nowVisible) visibleFolders.add(folder);
      else visibleFolders.delete(folder);
      tagElement.classList.toggle('active', nowVisible);
      tagElement.classList.toggle('inactive', !nowVisible);
      applyGraphFilters();
    }

    function handleSearch(_val) {
      applyGraphFilters();
    }

    function applyGraphFilters() {
      if (!graphInstance || !rawData?.topology) return;

      const searchInput = document.getElementById('graph-search');
      const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
      const includeNeighbors = document.getElementById('include-neighbors')?.checked ?? false;

      // 1. Calcul des voisins pour 1-hop et fantômes (AE5, R10)
      let activeNeighborIds = null;
      if (is1HopActive && focusedNodeId) {
        activeNeighborIds = new Set([focusedNodeId]);
        rawData.topology.links.forEach(l => {
          const s = typeof l.source === 'object' ? l.source.id : l.source;
          const t = typeof l.target === 'object' ? l.target.id : l.target;
          if (s === focusedNodeId) activeNeighborIds.add(t);
          if (t === focusedNodeId) activeNeighborIds.add(s);
        });
        const selectedNodeObj = rawData.topology.nodes.find(n => n.id === focusedNodeId);
        if (selectedNodeObj && selectedNodeObj.backlinks) {
          selectedNodeObj.backlinks.forEach(b => activeNeighborIds.add(b));
        }
      }

      // Surbrillance : voisinage du noeud selectionne (liens dans les deux sens + backlinks),
      // independamment du filtre 1-hop qui, lui, masque le reste.
      searchActive = Boolean(searchTerm);
      highlightIds = null;
      if (focusedNodeId) {
        highlightIds = new Set([focusedNodeId]);
        rawData.topology.links.forEach(l => {
          const s = typeof l.source === 'object' ? l.source.id : l.source;
          const t = typeof l.target === 'object' ? l.target.id : l.target;
          if (s === focusedNodeId) highlightIds.add(t);
          if (t === focusedNodeId) highlightIds.add(s);
        });
        const focusRaw = rawData.topology.nodes.find(n => n.id === focusedNodeId);
        if (focusRaw && focusRaw.backlinks) focusRaw.backlinks.forEach(b => highlightIds.add(b));
      }

      const matchingNodeIds = new Set();
      const neighborIds = new Set();

      if (searchTerm) {
        rawData.topology.nodes.forEach(n => {
          const title = (n.title || '').toLowerCase();
          const slug = (n.slug || '').toLowerCase();
          const aliases = (n.aliases || []).map(a => a.toLowerCase());
          if (title.includes(searchTerm) || slug.includes(searchTerm) || aliases.some(a => a.includes(searchTerm))) {
            matchingNodeIds.add(n.id);
          }
        });

        if (includeNeighbors) {
          rawData.topology.links.forEach(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            if (matchingNodeIds.has(s)) neighborIds.add(t);
            if (matchingNodeIds.has(t)) neighborIds.add(s);
          });
        }
      }

      const livePositions = new Map(graphInstance.graphData().nodes.map(n => [n.id, n]));
      const filteredNodes = rawData.topology.nodes.filter(n => {
        const folder = n.phantom ? 'phantom' : n.folder;
        if (!visibleFolders.has(folder)) return false;

        if (activeNeighborIds && !activeNeighborIds.has(n.id)) {
          return false;
        }

        if (searchTerm) {
          return matchingNodeIds.has(n.id) || neighborIds.has(n.id);
        }
        return true;
      }).map(n => {
        const next = {
          ...n,
          isNeighbor: searchTerm && includeNeighbors && neighborIds.has(n.id) && !matchingNodeIds.has(n.id),
          color: nodeColorFor(n),
          val: nodeValFor(n)
        };
        // Garde la position des noeuds deja places : sans cela, chaque clic ou filtre
        // relancait la mise en page depuis zero et le graphe changeait de forme.
        const prev = livePositions.get(n.id);
        if (prev) POSITION_KEYS.forEach(k => { if (prev[k] !== undefined) next[k] = prev[k]; });
        return next;
      });

      const activeIds = new Set(filteredNodes.map(n => n.id));
      const filteredLinks = rawData.topology.links.filter(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return activeIds.has(s) && activeIds.has(t);
      }).map(l => ({
        source: typeof l.source === 'object' ? l.source.id : l.source,
        target: typeof l.target === 'object' ? l.target.id : l.target,
      }));

      graphInstance.graphData({ nodes: filteredNodes, links: filteredLinks });

      const countLabel = document.getElementById('node-count-label');
      if (countLabel) {
        countLabel.textContent = filteredNodes.length + ' nœuds';
      }
    }

    function centerCameraOnNode(node, duration = 800) {
      if (!graphInstance || !node) return;

      const nx = typeof node.x === 'number' && !isNaN(node.x) ? node.x : 0;
      const ny = typeof node.y === 'number' && !isNaN(node.y) ? node.y : 0;
      const nz = typeof node.z === 'number' && !isNaN(node.z) ? node.z : 0;

      const currentPos = graphInstance.cameraPosition() || { x: 0, y: 0, z: 400 };
      let dx = (currentPos.x || 0) - nx;
      let dy = (currentPos.y || 0) - ny;
      let dz = (currentPos.z || 400) - nz;
      let dist = Math.hypot(dx, dy, dz);
      if (!dist || isNaN(dist)) {
        dx = 0; dy = 0; dz = 1; dist = 1;
      }

      const isPanelOpen = document.getElementById('reader-panel')?.classList.contains('open');
      const offsetRatio = isPanelOpen ? 0.25 : 0;
      const targetDist = Math.max(140, Math.min(280, dist * 0.7));

      const targetX = nx + (dx / dist) * targetDist + offsetRatio * 60;
      const targetY = ny + (dy / dist) * targetDist;
      const targetZ = is2D ? 400 : Math.max(160, nz + (dz / dist) * targetDist);

      try {
        graphInstance.cameraPosition(
          { x: targetX, y: targetY, z: targetZ },
          { x: nx, y: ny, z: is2D ? 0 : nz },
          duration
        );
      } catch (_) {}
    }

    function recenterOnActiveNode() {
      if (!focusedNodeId || !graphInstance) return;
      const liveNode = graphInstance.graphData().nodes.find(n => n.id === focusedNodeId);
      if (liveNode) centerCameraOnNode(liveNode, 500);
    }

    function openReaderPanel(node) {
      selectedNode = node;
      const panel = document.getElementById('reader-panel');
      const titleElem = document.getElementById('reader-title');
      const metaElem = document.getElementById('reader-meta');
      const bodyElem = document.getElementById('reader-body');
      if (!panel || !titleElem || !metaElem || !bodyElem) return;

      titleElem.textContent = node.title || node.id;

      // Métadonnées sans invention de date (AE7, R13)
      let metaHtml = '';
      metaHtml += '<span class="reader-badge">' + escapeHtml(node.type || node.folder || 'page') + '</span>';
      if (node.gate) {
        metaHtml += '<span class="reader-badge status-ok">gate: ' + escapeHtml(node.gate) + '</span>';
      } else if (node.isLegacy) {
        metaHtml += '<span class="reader-badge status-local">héritée</span>';
      }
      if (node.updated) {
        metaHtml += '<span class="reader-badge">Mis à jour le ' + escapeHtml(node.updated) + '</span>';
      }
      metaElem.innerHTML = metaHtml;

      let contentHtml = node.contentHtml || '<p><em>Aucun contenu textuel disponible pour cette page.</em></p>';

      if (node.backlinks && node.backlinks.length > 0) {
        contentHtml += '<div class="links-section">';
        contentHtml += '<div class="links-title">Liens entrants (' + node.backlinks.length + ')</div>';
        contentHtml += '<div class="links-chips">';
        node.backlinks.forEach(b => {
          const escB = escapeHtml(b);
          contentHtml += '<a class="wikilink" href="#/page/' + encodeURI(b) + '" data-target="' + escB + '">' + escB + '</a>';
        });
        contentHtml += '</div></div>';
      }

      bodyElem.innerHTML = contentHtml;
      panel.classList.add('open');

      bodyElem.querySelectorAll('a.wikilink').forEach(a => {
        a.onclick = (e) => {
          e.preventDefault();
          const target = a.getAttribute('data-target');
          if (target) {
            focusNodeInGraph(target);
          }
        };
      });
    }

    function closeReaderPanel() {
      const panel = document.getElementById('reader-panel');
      if (panel) panel.classList.remove('open');
      if (document.getElementById('tab-graph')?.classList.contains('active')) setRoute('graphe');
    }

    function focusNodeInGraph(nodeIdOrSlug) {
      if (!rawData?.topology?.nodes) return;
      // Pas d'entree #/graphe intermediaire dans l'historique : la route sera #/page/...
      const wasApplying = applyingRoute;
      applyingRoute = true;
      switchTab('graph');
      applyingRoute = wasApplying;
      if (!graphInstance) {
        initGraph();
      }
      if (!graphInstance) return;

      const rawNode = rawData.topology.nodes.find(n =>
        n.id === nodeIdOrSlug ||
        n.slug === nodeIdOrSlug ||
        n.id.endsWith('/' + nodeIdOrSlug) ||
        (n.slug && n.slug.endsWith('/' + nodeIdOrSlug)) ||
        (n.aliases || []).some(a => a.toLowerCase() === nodeIdOrSlug.toLowerCase())
      );
      if (!rawNode) {
        console.warn('Nœud non trouvé dans le graphe :', nodeIdOrSlug);
        return;
      }

      const folder = rawNode.phantom ? 'phantom' : rawNode.folder;
      if (!visibleFolders.has(folder)) {
        visibleFolders.add(folder);
        document.querySelectorAll('#folder-filters .folder-tag').forEach(tag => {
          if (tag.getAttribute('data-folder') === folder) {
            tag.classList.remove('inactive');
            tag.classList.add('active');
          }
        });
      }

      focusedNodeId = rawNode.id;
      setRoute('page/' + encodeURI(rawNode.id));
      openReaderPanel(rawNode);
      applyGraphFilters();

      setTimeout(() => {
        if (!graphInstance) return;
        const freshLive = graphInstance.graphData().nodes.find(n => n.id === rawNode.id);
        if (freshLive) {
          centerCameraOnNode(freshLive, 700);
        }
      }, 120);
    }

    window.addEventListener('DOMContentLoaded', () => {
      initData();
      initSyncIndicator();
      initLiveUpdates();
      initQuestion();
      // Ouvre la page demandee par l'URL (favori, Precedent, rechargement a chaud)
      if (window.location.hash) applyRoute();
    });
  </script>
</body>
</html>`;
};
