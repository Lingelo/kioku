---
name: lint
description: Auditer le coffre et traiter ce qui attend l'utilisateur — quarantaine, anomalies de la base (liens cassés, orphelines, index, ancien fonds non jugé). À lancer explicitement.
argument-hint: [domaine]
disable-model-invocation: true
---

Tu audites le wiki du domaine $ARGUMENTS (par défaut `VAULT_DOMAIN`), puis tu **fais traiter** par l'utilisateur ce qui attend une décision. Rien ne change dans le wiki sans son accord explicite. Déroule **CLAUDE.md §5.3**, et lis `domains/<domaine>/rules.md` (section `Lint`, s'il y en a une) pour les contrôles propres au domaine.

## 1. Audit déterministe (gratuit)

`kioku audit <domaine>` : pages, part héritée / admise par la gate, frontmatter absent, type ≠ dossier, liens cassés, pages orphelines, liens vers un autre domaine, pages hors index, entrées d'index fantômes. Pour un domaine à extension `org`, l'audit ajoute `org-absent` et `org-union` : présente-les comme le disent les règles du domaine.

**Journal** : `kioku rotate-log <domaine> --dry-run`. S'il annonce des mois à archiver, **propose** la rotation (mois, nombre d'entrées, taille avant / après) et ne la lance (`rotate-log <domaine>`, sans `--dry-run`) qu'après un « oui » explicite de l'utilisateur. Un refus « le circuit Plaud tourne » : la proposer au prochain lint.

## 2. Audit de lecture

Ce que le script ne voit pas : contradictions, claims périmées, concepts cités plus de 3 fois sans page, lacunes, prochaines sources à ingérer. Lis l'index puis les pages concernées.

**Ancien fonds** : les pages sans ligne `gate:` sont de l'or hérité, jamais jugé. Sonde-les par échantillon pour repérer injures, **portraits** nominatifs (« X est incompétent »), retours **non attribués** présentés comme des faits, imputation d'un acte malhonnête, données que les règles du domaine disent sensibles, contenu d'un autre domaine. Un **retour de travail attribué et daté** (« selon Alice, le 10/09, … ») n'est **pas** signalé : c'est ce qui sert aux points individuels (CLAUDE.md §9). Pour chaque cas : `kioku flag <domaine> <dossier/slug> <code> [note sans citation]`. **Ne recopie jamais le passage** ; la page ne bouge pas, elle rejoint « à décider ». Relis aussi `overview.md` (hors gate) pour les mêmes motifs.

## 3. À décider : la quarantaine

`kioku undecided <domaine>` liste, avec un code et une date, ce que la gate a retenu, ce que tu as signalé et les sources écartées par pointeur. Présente-les **un par un** (code, page cible, contexte en une ligne, sans extrait) ; l'utilisateur peut ouvrir la page sous `quarantine/<domaine>/` dans Obsidian. Pour chacune, **demande** :

- **garder** telle quelle → `kioku decide <domaine> <nom> keep [note]` (admise avec `juge=utilisateur`, ou drapeau levé pour une page héritée) ;
- **corriger** → `… decide <domaine> <nom> correct` : la page revient sous `.candidats/`, tu la reformules (faits, attentes et retours de travail attribués et datés ; ni trait, ni portrait, ni donnée sensible), elle repasse `check`, l'agent **`reviewer`** et `promote` ;
- **sortir du coffre** → `… decide <domaine> <nom> drop` (une page sortie du wiki garde une copie dans `quarantine/<domaine>/sortis/` ; relance `audit` pour les liens entrants).

N'appelle `decide` **qu'après une décision explicite de l'utilisateur dans cette conversation**. Chaque décision est journalisée (`quarantine/<domaine>/decisions.jsonl`) ; si elle vaut pour une famille de cas, propose de l'écrire comme règle dans `domains/<domaine>/rules.md` (section `Relecture`), ou dans `CLAUDE.md` §9 si elle vaut pour tous les domaines.

## 4. Rapport

En console : synthèse de l'audit, décisions prises, reste à traiter. Ajoute l'entrée `lint` dans `wiki/<domaine>/log.md` (et `correction` pour chaque page corrigée), **10 lignes au plus chacune** (CLAUDE.md §6) : le détail des cas est dans les pages corrigées et dans `quarantine/<domaine>/decisions.jsonl`, le récit dans le message de commit : `kioku commit <domaine> -m "lint(<domaine>) : …"` une fois les décisions appliquées (sans push ; jamais `git add` à la main).
