# Tableau de bord d'état du coffre (Kioku)

Visualiseur d'état opérationnel et graphe de connaissances 3D interactif pour Kioku, la base de connaissances.

## Fonctionnalités

1. **Onglet Pilote (Vue opérationnelle par défaut)** :
   - **Actions immédiates** : fiches en quarantaine et candidates en attente de passage de gate, avec commandes CLI de décision prêtes à copier.
   - **Suivi médaillon** : détection des sources dans le bronze n'ayant pas encore de fiche argent, et des fiches argent en attente de promotion or.
   - **Qualité et audit** : anomalies exploitables sur les pages récentes passées par la gate (avec raccourci vers le graphe), séparées de la dette technique du fonds hérité (avec 3 compteurs dédiés pour le bronze antérieur).
   - **États locaux** : surveillance du circuit Plaud (`.queue.json`, `.snapshot.json`, `.lock.json`) et de l'entrant non classé (`inbox/a-trancher/`), avec mention explicite de portée locale et distinction stricte inconnu / vide / présent.

2. **Onglet Graphe 3D (Navigation spatiale & lecture)** :
   - Graphe de force 3D interactif (manipulation par glisser-déposer, réchauffement et stabilisation à ressorts).
   - Coloration par type/dossier (`people`, `projects`, `meetings`, `sources`, `concepts`, `decisions`, `organizations`, `syntheses`) et distinction des cibles fantômes.
   - Recherche et filtres par dossier en temps réel.
   - **Panneau latéral de lecture** : rendu Markdown sur mesure sécurisé contre XSS, avec wikilinks cliquables naviguant dans le graphe, callouts Obsidian et liste des rétroliens (backlinks).

3. **Onglet Mode d'emploi (Guide interactif de la KB)** :
   - Cycle de vie médaillon (bronze immuable → argent nettoyé → or vivant).
   - Commandes CLI et skills au quotidien (`npm run <domaine>`, `/query`, `/ingest`, `/lint`, `/triage`) avec boutons de copie en un clic.
   - Règles d'or de la gate et critères d'admission (faits tangibles et retours de travail attribués vs portraits subjectifs ou données sensibles).
   - Conventions de structuration, règles de création des fiches `person` et `concept`, wikilinks et cloisonnement strict pro / perso.

4. **Onglet 問 Question (converser avec le wiki)** — serveur local uniquement :
   - Chaque tour lance `claude -p` en mode `query` sur le domaine du serveur, sous la garde, exactement comme `/query` en terminal : détection du domaine visé, format de réponse, entrée dans `log.md`, proposition `/save`.
   - `/query` préfixe le premier tour seulement ; les suivis gardent le contexte du fil (`--resume`). Un « oui » à « Filer avec `/save` ? » lance donc le file-back, gate comprise.
   - Pendant l'attente : pages du wiki lues en direct, puis texte au fil de l'eau ; à la fin, la réponse est rendue par le même moteur Markdown que le panneau de lecture, wikilinks cliquables.
   - Fil éphémère : recharger ou « nouveau fil » repart à vierge, rien n'est stocké. Une seule réponse à la fois par serveur (un second onglet reçoit « occupé »). Échap ou « Interrompre » tue la session.
   - Prérequis : Claude Code installé et authentifié sur la machine. Chaque tour prend de l'ordre de 30 à 60 s et consomme l'abonnement Claude. L'entrée que chaque question ajoute à `log.md` ne lève pas le bandeau « coffre modifié » : le journal n'est affiché nulle part (un `/save` admis, lui, le lève, puisqu'une page entre dans l'or).
   - En `file://`, l'onglet indique la commande de lancement du serveur et ne tente aucune connexion.

## Design « Kioku » (Zen / wabi-sabi)

- **Thème unique papier washi** : fond `#F4EFE6`, texte encre sumi, filets fins, aucune ombre, aucun dégradé, aucun flou. Il n'y a plus de thème sombre ni de bascule.
- **Pigments traditionnels** : chaque étape a une teinte décorative (pastilles, barres, liserés) et une variante `-ink` réservée au texte, calibrée à 4,5:1 sur sa surface la plus défavorable. Le vermillon est réservé à la gate et aux alertes.
- **Kanji décoratifs** (舵 図 書 銅 銀 金 関, sceau 脳) : en police système japonaise, sans fichier embarqué, toujours accompagnés du libellé français. Sur une machine sans police japonaise, ils peuvent s'afficher en carrés vides.
- **Graphe** : couleurs lues dans les tokens CSS (`--folder-*`, `--graph-*`), nœuds opaques, fantômes translucides.
- **Garde-fous** : `design.test.mjs` vérifie le contraste WCAG des tokens, l'absence de couleur littérale hors du bloc de tokens et l'absence des contenus inventés par la maquette Stitch.

## Commandes d'utilisation

```bash
# Générer le dashboard pro
npm run dashboard:pro
# ou
npm run dashboard

# Générer le dashboard perso
npm run dashboard:perso

# Générer les deux dashboards
npm run dashboard:all

# Générer et lancer un serveur local de visualisation en direct
npm run dashboard:serve:pro    # Port 3456 par défaut (ou npm run dashboard:serve)
npm run dashboard:serve:perso  # Port 3457 par défaut

# Développement : rechargement à chaud (node --watch)
npm run dashboard:dev          # pro ; dashboard:dev:perso pour le perso
```

**Rechargement à chaud** : sous `dashboard:dev`, Node redémarre le serveur à chaque modification d'un module du dashboard. Chaque démarrage porte un identifiant (`boot`, transmis par `/events`) ; la page le compare à celui de sa première connexion et se recharge d'elle-même. Sous `dashboard:serve`, la page ne se recharge jamais seule : un redémarrage du serveur lève le bandeau, comme une modification des données du coffre. Le rendu du graphe 3D est suspendu hors de son onglet et quand la page est cachée.

**Routes** (dans le hash, donc valables aussi en `file://`) : `#/pilote`, `#/graphe`, `#/question`, `#/guide`, `#/page/<dossier>/<slug>` (ouvre le graphe sur la page, panneau de lecture compris). Précédent / Suivant, favoris et rechargement gardent la page affichée. L'ancien format `#page/<id encodé>` des liens Markdown reste accepté.

Les fichiers HTML autonomes sont générés sous `tools/dashboard/` :
- `tools/dashboard/dashboard-pro.html`
- `tools/dashboard/dashboard-perso.html`

Ils peuvent être ouverts directement dans n'importe quel navigateur, soit par double-clic (protocole `file://`), soit via `npm run dashboard:serve:pro` / `npm run dashboard:serve:perso`.

### Serveur local en direct (live reload)

Le serveur local (`tools/dashboard/serve.mjs`) offre une expérience « toujours à jour » :
- **Rendu à la volée** : chaque chargement de page relit et rend l'état actuel du coffre sans étape de génération préalable.
- **Surveillance ciblée et notification SSE** : le serveur surveille les dossiers du domaine actif (`wiki/`, `.candidats/`, `quarantine/`, `silver/`, `raw/`, verrous Plaud et verdicts associés) et pousse un signal Server-Sent Events (`/events`) regroupé (500 ms).
- **Bandeau discret** : quand l'état change, la page affiche un bandeau indiquant depuis combien de temps le coffre a été modifié avec un bouton pour recharger. Rien ne bouge pendant la lecture.
- **Arrêt propre** : le serveur s'arrête immédiatement avec Ctrl+C dans son terminal, fermant toutes les connexions actives sans laisser aucun processus ni fichier résiduel.
- **Note sur l'entrant** : les compteurs de `inbox/` sont lus lors du rendu mais ne déclenchent pas de bandeau automatique (zone non classée hors silo).

## Garanties d'architecture et de sécurité

- **Zéro réseau externe (R7, R8, KTD2, KTD8)** : aucune dépendance externe, aucune police distante, aucun CDN, aucun appel réseau sortant vers un tiers (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`). La bibliothèque 3D `3d-force-graph@1.80.0` (UMD) est vendorisée sous `tools/dashboard/vendor/`. En mode serveur local (écoute exclusive sur loopback `127.0.0.1`), les requêtes sont limitées à la même origine, sans aucun en-tête `Access-Control-Allow-*`, et protégées contre le DNS rebinding par validation stricte du header `Host`. En consultation statique (`file://`), aucune connexion n'est tentée. La page elle-même n'appelle jamais de tiers ; la session `claude` lancée par l'onglet 問 Question appelle l'API Anthropic, comme toute session Claude Code.
- **Politique de sécurité de contenu (CSP)** : chaque réponse HTML applique `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **Cloisonnement strict pro / perso (R1, R14, KTD5)** : un serveur ne lit et ne sert qu'un seul domaine à la fois (`pro` ou `perso`). Deux serveurs peuvent tourner en parallèle sur leurs ports distincts sans aucune fuite croisée.
- **Silo de session** : lancé depuis une session Claude (`CLAUDECODE` ou `VAULT_DOMAIN` présent), le script ne génère et ne sert que le domaine de la session (défaut `pro`, comme la garde) ; `all` et l'autre domaine sont refusés. La garde filtre le texte des commandes, pas les lectures du script : le contrôle vit donc ici. Hors session (terminal), aucune restriction.
- **Rendu Markdown sécurisé et échappement des données (R20, R21, R22, KTD7, KTD8)** : parseur sur mesure sans dépendance tierce, échappant tout HTML brut avant transformation des blocs. Toutes les données issues du coffre (notes de quarantaine, wikilinks, commandes CLI) sont strictement échappées dans le HTML et les attributs.
- **Immuabilité (R4)** : la génération et le serveur n'écrivent rien dans le coffre. Seule exception, et elle passe par la garde : la route `POST /ask` de l'onglet 問 Question lance une session `query`, qui peut écrire ce qu'une session `query` écrit en terminal (`log.md`, `index.md`, candidates de `/save` sous `.candidats/`), rien de plus.
- **Route de question (`POST /ask`)** : seule route qui accepte `POST`. Elle exige le jeton tiré au démarrage du serveur (injecté seulement dans la page servie en direct, jamais dans les fichiers générés) dans l'en-tête `X-Kioku-Token`, un `Origin` égal à l'hôte du serveur (absent = refus) et un corps JSON borné. Un site tiers ouvert dans le navigateur ne peut pas envoyer cet en-tête sans pré-vol CORS, que le serveur ne valide jamais. La session démarre à la racine du coffre avec `CLAUDE_PROJECT_DIR` (sinon la garde ne se chargerait pas) et refuse de partir si aucune garde n'est déclarée (hook du projet ou plugin `kioku` activé, comme `kioku doctor`). Ses outils sont restreints : lecture, édition, relecteur, et seulement `kioku check` et `kioku promote` (ni `decide`, ni `quarantine`, ni `seed` : la garde ne filtre pas ces sous-commandes, et le wiki contient des transcriptions de tiers). La question passe par l'entrée standard, jamais en argument de commande.

## Tests

```bash
# Lancer l'ensemble des tests du dashboard
node --test tools/dashboard/*.test.mjs
```
