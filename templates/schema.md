<!-- Schéma générique Kioku. Écrit par `kioku init` et à chaque montée de version ; ne pas modifier à la main :
     ce qui est propre à ce coffre va dans CLAUDE.md (identité, décisions datées) ou dans domains/<D>/rules.md. -->

# Schéma Kioku — coffre de connaissance à médaillon

> Manuel opérationnel commun à tous les coffres Kioku, importé par le `CLAUDE.md` du coffre. Il applique le pattern *LLM Wiki* (sources brutes / wiki maintenu par le LLM / schéma, avec ingest · query · lint, `index.md` et `log.md`) et y ajoute deux choses : une **architecture médaillon** (bronze → argent → or) et des **silos par domaine**, tenus par une garde (hook), pas par une consigne.

Les domaines du coffre, leurs extensions et ses modules sont déclarés dans `kioku.config.json`. Chaque domaine a ses règles dans `domains/<D>/rules.md` (sections `Périmètre`, `Ingestion`, `Requête`, `Lint`, `Relecture`), lues par les skills et par le relecteur. **En cas de conflit, les règles du domaine l'emportent pour ce qu'elles nomment explicitement** ; pour le reste, ce schéma s'applique.

---

## 1. Confidentialité

- Le coffre porte des données sensibles (noms, décisions internes, vie privée). S'il est synchronisé par un remote, ce remote est **privé**, sans exception : avant tout `git remote add` ou changement de remote, le vérifier (`gh repo view <repo> --json isPrivate`).
- **`inbox/` reste local** (`.gitignore`) : non classé, il peut relever de n'importe quel domaine. On le trie (`/kioku:triage`) avant de changer de machine.
- Plusieurs domaines dans un même dépôt : le silo n'est **pas tenu par git mais par la garde** (§3). Un push publie tous les domaines.
- **Interdictions** : aucun push vers un remote public ; aucun upload vers un service tiers sans validation explicite ; aucune copie hors du dossier sans contexte explicite.
- **L'historique git contient le brut et tous les domaines** : la garde interdit `git show|grep|diff|log -p|cat-file|archive|blame|stash|restore|checkout`. Le contenu se lit dans le dossier de son domaine.
- Donnée manifestement sensible (mot de passe, token, NDA, RH nominative) : **alerter avant d'écrire**.

---

## 2. Architecture : médaillon × domaine

| Étage | Dossier | Rôle | Qui y lit |
|---|---|---|---|
| **Bronze** | `raw/<D>/{meetings,articles,pdfs,transcripts,assets}/` | La source telle qu'elle est entrée. **Immuable.** | ingestion seule |
| *(entrant)* | `inbox/` | Sources pas encore classées. Sans domaine. | tri seul |
| **Argent** | `silver/<D>/<slug>.md` | Une fiche par source : classée, nettoyée, locuteurs résolus, drapeaux posés. | ingestion seule |
| **Or** | `wiki/<D>/{sources,meetings,people,organizations,projects,concepts,decisions,syntheses}/` | Les pages du wiki. **On requête ici, uniquement ici.** | requête, ingestion |
| *(retenu)* | `quarantine/<D>/` | Ce que la gate a retenu, ou consigné par pointeur. Attend l'utilisateur. | personne (via `kioku undecided`) |

Fichiers par domaine, sous l'or : `index.md` (catalogue, lu en premier), `log.md` (journal en ajout seul, mois courant), `log/<AAAA-MM>.md` (archives, écrites par `kioku rotate-log`, jamais à la main), `overview.md` (synthèse vivante).

```
<coffre>/
├── CLAUDE.md                 part propre au coffre (importe ce schéma)
├── kioku.config.json         domaines, extensions, modules (protégé)
├── domains/<D>/rules.md      règles du domaine
├── raw/<D>/  silver/<D>/  wiki/<D>/  quarantine/<D>/
├── .candidats/wiki/<D>/      pages en attente de la gate
├── .verdicts/                verdicts du relecteur (liés au contenu)
└── inbox/                    entrant (jamais versionné)
```

**Amorçage d'un wiki existant** : des pages déjà présentes sous `wiki/<D>/` sans ligne `gate:` sont de l'**or hérité**. `kioku seed <D>` en fait un instantané daté dans `silver/<D>/heritage/`, une seule fois ; ce dossier est ensuite **fermé dans tous les modes**. Toute nouvelle source passe bronze → argent → or ; une page héritée que l'on modifie repasse la gate.

---

## 3. Sessions : mode et domaine

Le coffre s'ouvre avec `VAULT_MODE` et `VAULT_DOMAIN`, posés par le lanceur. Sans variables, la session prend `default_session` de la config. La session démarre sur la tâche de son mode (`ingest` → `/kioku:ingest`, `triage` → `/kioku:triage`, `setup` → `/kioku:setup`, lint → `/kioku:lint <D>` en mode `query`).

| Mode | Lecture | Écriture |
|---|---|---|
| **query** (défaut) | `wiki/<D>/` | `.candidats/wiki/<D>/`, `wiki/<D>/{index,log}.md` |
| **ingest** | `raw/<D>/`, `silver/<D>/`, `wiki/<D>/`, `.candidats/wiki/<D>/` | `silver/<D>/`, `.candidats/wiki/<D>/`, `wiki/<D>/{index,log,overview}.md` |
| **triage** | `inbox/` | `mv` vers `raw/<D>/` |
| **setup** | config, `domains/` | rien en direct : `kioku init` et `kioku add-domain` seulement |

Dans aucun mode : un autre domaine, `quarantine/`, `.verdicts/`, la config ou un registre. **`wiki/` ne s'écrit jamais directement**, sauf `index.md`, `log.md` et, en `ingest`, `overview.md` (hors gate, relu au lint). La garde refuse le reste ; elle ne se modifie pas depuis une session. Si elle bloque à tort, le dire à l'utilisateur.

Une session `query` ne voit ni le brut ni l'argent : elle répond depuis l'or ou dit « pas trouvé dans le wiki, à investiguer ».

---

## 4. Workflows (skills)

Skills : `/kioku:query`, `/kioku:ingest`, `/kioku:triage`, `/kioku:save`, `/kioku:lint`, `/kioku:setup`, `/kioku:add-domain`. `query` et `save` se déclenchent aussi en langage naturel ; les autres sont réservés à l'utilisateur.

### 4.1 Ingest — bronze → argent → or

1. **Lire** la source dans `raw/<D>/…` en entier. Présenter 3 à 5 *key takeaways* et les lacunes critiques.
2. **Argent** : écrire `silver/<D>/<slug>.md` (frontmatter `raw`, `domain`, `flags`, `status` ; résumé structuré, points clés, entités, lacunes). Locuteurs résolus **en hypothèse signalée** (un « Speaker 1 » n'est pas un fait). Aucune injure ni portrait recopié ; les retours de travail attribués et datés (§7) se gardent. Propos insultants, portrait ou donnée sensible : **pointeur en quarantaine** (`kioku quarantine`), drapeau dans `flags:`.
3. **Or** : depuis la fiche argent, rédiger sous `.candidats/wiki/<D>/…` la page `sources/` (avec `raw:`), la page `meetings/` si réunion (la page source la lie : `*Réunion structurée : [[meetings/<slug>]]*`), les ADR dans `decisions/`, les entités touchées (règles ci-dessous ; callout `> [!warning]` sur contradiction).
4. **Gate** (§7) : `kioku check` → agent `kioku:reviewer` → `kioku promote`.
5. Mettre à jour `index.md`, `overview.md` si la compréhension globale change, et `log.md` ; puis `kioku commit <D>` (chemins calculés par le code, jamais de push).
6. Rapporter : pages admises / retenues, contradictions, questions ouvertes.

Pour modifier une page déjà dans l'or : `kioku stage <D> <dossier/slug>` la copie sous `.candidats/`, sans sa ligne `gate:` (session `ingest` de son domaine).

**Fiches `person`.** Un `stub` quand la personne est (a) **centrale** à la source **ou** (b) nommée dans **au moins deux sources** ; sinon le lien reste orphelin. L'identité est **donnée par la source**, jamais déduite d'un locuteur ni d'un prénom seul. Une fiche ne porte que le rôle, l'organisation et des retours de travail attribués et datés. Les règles du domaine peuvent restreindre davantage (fiche sur demande seulement).

**Pages `concept`.** Un `stub` quand la notion est (a) **centrale** à la source **ou** (b) citée dans **au moins deux sources**. Il s'ouvre par `## Vue d'ensemble` et ne contient que ce que les sources disent. Pas de page pour un terme générique, pas de doublon (vérifier l'index et les `aliases:`). Chaque domaine tient ses propres pages : un concept connu d'un autre domaine n'y est ni lié ni copié.

Variantes : **meeting** (source + meeting + ADR liés par `^[[meetings/…]]`), **PDF** (`pages:` au-delà de 10 pages), **article** (images lues séparément si pertinent).

### 4.2 Query — l'or uniquement

D'abord, **détecter le domaine visé** par la question (signaux dans `domains/<D>/rules.md`, section `Requête`). S'il diffère de celui de la session : ne rien chercher, ne rien dire de l'autre domaine, indiquer la commande de relance. Jamais deux domaines dans une réponse. Puis lire `wiki/<D>/index.md`, drill dans 2 à 5 pages via les `[[wikilinks]]`, répondre avec citations. Wiki insuffisant : « pas trouvé dans le wiki, à investiguer ». Proposer le file-back, ajouter l'entrée de log.

### 4.3 Lint

Orphelins, liens cassés, contradictions, claims périmées, concepts sans page, frontmatter, lacunes, prochaines sources, **à décider** (`kioku undecided`), **ancien fonds** (pages sans `gate:` sondées pour injures, portraits, données sensibles, contenu d'un autre domaine), `overview.md`, plus les contrôles des extensions du domaine. Rapport console, aucune modification sans validation. Se lance **en mode `query`**.

**Lien cassé ou lacune.** Un lien vers une page inexistante, cité par **une seule source** et **non central**, est une **lacune voulue**, pas une anomalie. Il devient anomalie quand la cible est citée par **au moins deux sources**, qu'elle est **centrale**, ou que le lien vise une page **existante sous un autre nom**. On compte par **cible** ; une paire source + meeting compte pour une source.

### 4.4 Save (file-back)

Synthèse durable → `.candidats/wiki/<D>/syntheses/<slug>.md` → gate → index → log. Ne cite que des pages or déjà lues.

### 4.5 Module Plaud (optionnel)

Si le module est déclaré dans la config : le connecteur dépose dans `inbox/`, le tri classe sur le **contenu** ou s'abstient (parqué dans `inbox/a-trancher/`), une **confirmation** montre ce qui va entrer dans l'or par domaine, puis une session `ingest` par source. Lancé par l'utilisateur, jamais planifié, depuis le checkout principal.

---

## 5. Conventions

- **Fichiers** : `kebab-case.md`, ASCII, en anglais ; sources préfixées de la date ISO. **Le nom de fichier est lu par tout lien** : jamais de nom d'une personne évaluée, d'un candidat ni d'une donnée sensible dans un slug (préférer `2026-07-10-brief-candidate-profile`).
- **Liens** : `[[wikilinks]]` relatifs au domaine, jamais de lien Markdown, jamais vers un autre domaine. Lier vers une page inexistante est encouragé (lacune matérialisée).
- **Citations** : toute affirmation factuelle se trace à une source (`sources:` ou `^[[sources/xyz]]`). Sans source : `> ⚠️ non sourcé` ou l'omettre. Ne jamais inventer une citation.
- **Frontmatter** (toute page) : `type` (`source|person|organization|project|meeting|decision|concept|synthesis`), `title`, `tags`, `status`, `sources`, `aliases`, `created`/`updated` — sauf `source` (`ingested_on`, `source_type`, `raw`), `meeting` (`date`, `participants`, `project`, `decisions`), `decision` (`decided_on`, `status: proposed|accepted|deprecated|superseded`, `supersedes`, `superseded_by`, `meeting`, `project`, `stakeholders`). `person` : `role`, `organization`, `division`. `project` : `status`, `sponsor`, `team`. `synthesis` : `question`, `derived_from`.
- **`gate:`** est posé par `kioku promote`, jamais à la main. Une page sans cette ligne est de l'or hérité.
- **Extension `org`** (domaines qui la déclarent) : `org:` dit **où la connaissance a été acquise**, distinct de `organization:`. Une liste **sur une seule ligne**, identifiants du registre triés : `org: [acme, globex]`. Source, meeting, ADR : l'organisation de la source ; entité : l'union des `org:` de ses sources (on n'en retire jamais). `check` le contrôle ; `org-tag:` est posé par `kioku tag-org`, jamais à la main.
- **Sections types** — source : `Résumé`, `Points clés`, `Entités mentionnées`, `Citations`, `Lacunes à investiguer` ; meeting : `Ordre du jour`, `Décisions prises`, `Actions`, `Sujets ouverts` ; ADR : `Contexte`, `Décision`, `Alternatives écartées`, `Conséquences`, `Suivi` ; concept / organization / project / synthesis : `## Vue d'ensemble` d'abord (synthesis : + `## Références`).
- **Log** : `## [AAAA-MM-JJ HH:MM] <type> | <titre>` puis `- source :`, `- pages touchées :`, `- découvertes :`. **10 lignes au plus** (3 pour une `query`). Types : `ingest` · `triage` · `gate` · `query` · `lint` · `file-back` · `schema` · `correction` · `repo`. Rotation mensuelle par `kioku rotate-log <D>`, proposée au lint, validée par l'utilisateur.
- **Index** : `- [[chemin/slug]] — résumé ≤120 caractères`.

---

## 6. Règles internes au LLM

- Lire `wiki/<D>/index.md` avant toute query ; lire les **5 dernières entrées** de `log.md` en début de session (`grep -n "^## \[" log.md | tail -5`), jamais le fichier entier.
- Ne jamais réécrire le brut, ne jamais écrire directement sous `wiki/`, ne jamais contourner ni modifier la garde.
- Ne jamais ranger une source dans un domaine « pour aller vite » : au moindre doute, s'abstenir et demander.
- Horodater avec la date du système ; challenger une demande qui pollue le wiki (doublon, sur-fragmentation) ; proposer le file-back d'une analyse durable.
- Si le relecteur ne répond pas : **rien n'entre**, on le dit, on ne boucle pas.
- Modification structurelle du schéma propre au coffre : une entrée `schema` dans `log.md` et le « pourquoi » dans le `CLAUDE.md` du coffre.

---

## 7. La gate : ce par quoi une page entre dans l'or

Le rédacteur ne juge pas sa propre page.

1. **Candidate** sous `.candidats/wiki/<D>/<dossier>/<slug>.md` (chemin final).
2. `kioku check <fichier>` — format, provenance (`raw:` existant, fiche argent pour une nouvelle source), pas de lien Markdown, pas de secret, pas de lien vers un autre domaine. Sans modèle, sans coût.
3. **Relecteur** : l'agent `kioku:reviewer`, un appel distinct du rédacteur, lit la page seule avec le socle commun et `domains/<D>/rules.md` (section `Relecture`), et enregistre un verdict **lié au contenu exact** (sha256) et **à son domaine** : `ok` ou `hold <code>`. Codes : `insulte`, `jugement-personne`, `diffamation`, `domaine`, `sensible`.
4. `kioku promote <fichier>` — écrit sous `wiki/<D>/` avec la ligne `gate:` si `check` passe **et** verdict `ok` du relecteur de `<D>`.

Issues : **admise** · **refusée** (format ou provenance : on corrige) · **retenue** (`hold` : quarantaine, l'utilisateur décide au lint, sa décision devient une règle du domaine) · **sans verdict** (rien n'entre).

**La frontière : le portrait contre le retour de travail attribué.**

- **Passe** : un fait daté (« Alice n'a pas livré le module Atlas le 12/03 ») ; une attente (« Bruno souhaite plus d'implication sur le marché nordique ») ; un **retour de travail attribué**, à quatre conditions : (1) il porte sur la **conduite professionnelle ou les résultats** ; (2) il est **attribué** et **daté**, avec la source ; (3) c'est une **observation sur des situations**, pas un trait permanent ; (4) il n'est **pas assemblé en portrait** (synthèse ou étiquette qui réduit la personne à des traits). Une liste de retours datés, de sources ou de dates différentes, chacun sur une situation distincte, n'est pas un portrait. Idem pour la reconnaissance, et pour ce qu'une personne dit d'elle-même.
- **N'entre pas** : l'insulte ; le **trait** (« Alice est incompétente ») ; un retour non attribué présenté comme un fait ; un état émotionnel prêté par le rédacteur ; un portrait né de l'assemblage de faits anodins ; une accusation (« Bruno a détourné le budget »), sauf rapportée comme allégation attribuée à sa source ; les données que le domaine déclare **sensibles**.
- **Dans le doute, on retient** : l'utilisateur tranche.

**Limites, dites** : la gate vérifie la provenance, pas la vérité (le lint garde ce rôle) ; le relecteur est un autre appel de modèle dans la même session (indépendance de contexte, pas de processus) ; `overview.md` est hors gate, relu au lint.
