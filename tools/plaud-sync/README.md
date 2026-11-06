# plaud-sync

Circuit **Plaud → coffre** : les notes de réunion captées par Plaud arrivent dans `inbox/`, sont triées vers `raw/<domaine>/`, puis ingérées bronze → argent → or. Node seulement (Windows, macOS, Linux), aucun token lu ici : l'authentification est déléguée au MCP officiel `@plaud-ai/mcp` (OAuth, cache dans `~/.plaud/`).

**Lancé par l'utilisateur, jamais planifié** : un tri erroné vers le mauvais domaine s'écrirait dans le wiki sans relecture (CLAUDE.md §5.5). À lancer depuis le checkout principal, car `inbox/` n'est pas versionné.

## Lancer

Depuis le checkout principal du coffre. `kioku plaud` relaie `node <core>/tools/plaud-sync/run.mjs --vault .` : `run.mjs` n'existe pas dans le coffre.

```
kioku plaud                        # 7 derniers jours
kioku plaud --since 2026-09-14
kioku plaud --dry-run              # montre ce qui serait déposé, aucune session lancée
kioku plaud --skip <id Plaud>      # écarte un enregistrement pour de bon (répétable)
kioku plaud --skip-fetch           # tri + ingestion de ce qui est déjà dans l'entrant / la file
kioku plaud --group-by-day         # une session par journée et par domaine, au lieu d'une par source
kioku plaud --skip-fetch --decide <fichier>=<domaine>   # tranche une source parquée (répétable)
kioku plaud --drop <fichier> [<fichier>...]             # écarte une source parquée (seen.json « ecarte », fichier supprimé)
kioku plaud --requeue <domaine> <chemin>                # remet en file une source déplacée à la main vers un autre domaine
kioku plaud --yes                  # ingère sans demander confirmation (requis sans terminal)
kioku plaud --retries 2 --retry-delay 60   # relances d'une ingestion qui échoue (défaut : 1, après 30 s)
```

Raccourcis npm posés par `kioku init` : `npm run plaud:sync` (= `kioku plaud`), `plaud:dry-run`, `plaud:pending` (= `--skip-fetch`), `plaud:drop`. Une option s'ajoute après `--` : `npm run plaud:sync -- --since 2026-10-01`.

Première connexion : `npx -y @plaud-ai/mcp@latest` une fois, pour l'OAuth.

### Traiter les sources parquées (`inbox/a-trancher/`)

Le rapport de fin liste ce que le tri n'a pas tranché. Lire `inbox/a-trancher/_raisons.md` et les fichiers **dans son propre terminal ou Obsidian** : une session `query` n'a pas accès à l'entrant (garde), et `! cat` y ferait entrer le brut. Puis, fichier par fichier, une des trois issues :

| Issue | Commande | Effet |
|---|---|---|
| **Ingérer** | `kioku plaud --skip-fetch --decide <fichier>=pro --decide <autre>=perso` | tri forcé dans ce domaine, confirmation, puis ingestion |
| **Écarter** | `kioku plaud --drop <fichier> [<fichier>...]` | `plaud_id` consigné `ecarte` dans `seen.json`, fichier et ligne de `_raisons.md` supprimés ; ni fetch, ni session |
| **Laisser** | rien | reste parqué, relisté à chaque rapport, jamais ingéré sans `--decide` |

- **Ne jamais supprimer un parqué à la main** : sans trace dans `seen.json`, le fetch suivant le redépose. `plaud:drop` refuse un fichier sans `plaud_id:` et le laisse en place.
- `--decide` se lance dans un vrai terminal : la confirmation avant l'ingestion y attend un « oui ». Ne pas ajouter `--yes` pour la contourner.
- Ranger une source sensible en `pro` (rémunération, RH) ne fait pas entrer le sensible : l'ingestion et le relecteur le retiennent (CLAUDE.md §9), à voir ensuite dans `npm run undecided`.
- Après un `plaud:drop` : commiter `tools/plaud-sync/seen.json`.

Code de sortie : `0` tout est rangé et ingéré ; `2` il reste des sources à reprendre ou à trancher ; `1` erreur.

**Un seul lancement à la fois** par coffre (`lock.mjs`). Une ingestion dure des minutes et la file ne perd son entrée qu'une fois la fiche argent écrite : sans verrou, un second lancement pendant ce temps relancerait une session sur la même source, doublant les candidates et les entrées de `index.md` / `log.md`. Le second lancement échoue tout de suite, en donnant le PID du premier. Rien à nettoyer après un `kill` : un verrou dont le processus n'existe plus est repris au lancement suivant. `--dry-run` ne prend pas le verrou (il n'écrit rien).

## Les étapes

1. **Dépôt** (`fetch-notes.mjs`) : liste les enregistrements Plaud, écarte ceux déjà connus (voir *Déduplication*), dépose le reste dans `inbox/`, sans domaine.
2. **Tri** : une session `claude -p` en mode `triage` range chaque source dans `raw/pro/` ou `raw/perso/` **sur le contenu**, car le MCP n'expose pas les dossiers Plaud. Au moindre doute (autre organisation, source mixte, donnée sensible), elle s'abstient : la source est parquée dans `inbox/a-trancher/`, raison dans `_raisons.md`, sans bloquer les lancements suivants.
   Une note **sans contenu exploitable** (test de connexion, fragment, silence) est parquée de même, avec une ligne `VIDE` au lieu d'`ABSTENTION` (raison préfixée « sans contenu » dans `_raisons.md`).
3. **Écart proposé** : s'il y a des notes `VIDE`, le script les liste avec leur taille et leur raison et demande `Les ecarter pour de bon ? [o]ui / [N]on` (Entrée = non). Oui : même effet que `--drop` (`plaud_id` consigné `ecarte` dans `seen.json`, à commiter). **Ni `--yes` ni l'absence de terminal n'écartent rien** : `--yes` veut dire « ingère sans demander », et un écart ne se défait qu'en éditant `seen.json` à la main (retirer la ligne de l'id, puis relancer un fetch). Une source tranchée par `--decide` n'est jamais proposée.
4. **Confirmation** : avant toute ingestion, le script affiche ce qui va entrer dans l'or, **par domaine**, et demande `Ingerer cette liste ? [o]ui / [N]on` (Entrée = non). C'est le dernier moment où une erreur de domaine du tri se corrige sans effort ; après, la source est dans le mauvais wiki et seul le relecteur peut encore la retenir. Sur un refus, rien n'est écrit et les sources restent dans la file. Pour corriger le domaine d'une source `neuf` : `mv raw/<de>/<chemin> raw/<vers>/<chemin>`, puis `kioku plaud --requeue <vers> <chemin>` (sous le verrou ; le chemin reste sous `raw/<vers>/`), puis `kioku plaud --skip-fetch`. Sans terminal, rien n'est ingéré sans `--yes`.
5. **Ingestion** : une session `ingest` par source, dans le domaine où le tri l'a rangée. La gate et le relecteur s'appliquent comme pour une ingestion manuelle. Avec `--group-by-day`, les sources d'une **même journée et d'un même domaine** partagent un **fil de conversation** (voir ci-dessous). Les deux domaines ne sont **jamais** dans le même fil, une source sans date dans son nom reste seule, et l'ordre chronologique est conservé.
   Une session qui rend un code non nul est **relancée**, à froid, après une attente (`--retries`, défaut 1 ; `--retry-delay`, défaut 30 s). L'état est relu sur les fichiers avant chaque relance : une source entrée dans l'or malgré le code n'est pas relancée, une source déjà rédigée repart en reprise. Le code de sortie de `claude` ne dit pas si l'erreur est passagère (le 05/11, une erreur API 422 après la rédaction) : on relance sur tout échec, et le plafond borne le coût d'un échec qui se reproduit.
6. **Rapport** : calculé sur les fichiers, jamais sur ce qu'une session déclare (ingérées / pas entrées dans l'or / à trancher / retenues par la gate).

### `--group-by-day` : un fil de conversation par journée

Chaque source garde **son tour** (une source par tour, sa propre fiche argent, sa propre page), mais les tours d'une même journée s'enchaînent **dans la même conversation** : `--session-id` au premier, `--resume` aux suivants. Deux effets :

- **Ce qui a été lu reste en contexte.** La séance de l'après-midi ne relit ni l'index ni les pages déjà ouvertes le matin.
- **Les séances se recoupent.** Celle de 14:00 confirme, précise ou contredit celle de 09:31 — ce que trois sessions froides ne peuvent pas faire.

Mesuré le 22/09 sur deux tours et un contexte de 82 ko : `cache_creation` tombe de **~60-80 k tokens à quelques centaines**, la durée de **66 s à 19 s**. ⚠️ **Le coût en dollars ne suit pas** : environ **-25 %**, et pas systématiquement — le contexte accumulé est relu à chaque tour et il grossit. Le gain est sur le **temps**, pas sur la facture.

Une source par tour, et non un prompt qui porterait toute la journée : **si un tour échoue, les suivants continuent**. Le fil est alors abandonné et la source suivante repart à froid — mieux vaut relire le contexte que perdre une source.

⚠️ **Limite** : une journée à beaucoup de séances finit par remplir le contexte, et la session compacte. Au-delà de quelques sources, on ne sait plus ce qu'elle a gardé. `--group-by-day` reste **opt-in** pour cette raison.

### Ce que « ingérée » veut dire

**La page or fait foi**, pas la fiche argent. Une source est traitée quand `wiki/<domaine>/sources/<slug>.md` porte `raw:` = son chemin **et** qu'aucune candidate ne la cite encore sous `.candidats/wiki/<domaine>/` (une candidate `sources/` de même `raw:`, ou toute candidate dont le `sources:` nomme sa page source). Sinon, elle reste en file avec son état :

| État | Ce qui existe | Ce qu'il reste à faire |
|---|---|---|
| `neuf` | rien, ou pas de fiche argent | toute l'ingestion |
| `argent` | fiche argent, pas de page or | la gate (`check`, relecteur, `promote`), l'index, le journal |
| `candidats` | des candidates de la source restent sous `.candidats/` (page source admise ou non) | la gate sur ces candidates seulement : la session ne rédige rien de nouveau |

Une reprise **ne réécrit pas** ce qui est déjà conforme : un verdict est lié à l'empreinte exacte d'une page, la réécrire l'invalide.

> Le critère était auparavant la fiche argent, écrite à l'étape 2 sur 3. Le 22/09, une session s'est arrêtée entre les candidates et la gate : le rapport a annoncé **« 1/1 ingérée »** pour une source qui n'était jamais entrée dans le wiki, et trois pages sont restées dans `.candidats/`, invisibles du rapport comme de `vault.mjs undecided`.
>
> La gate admet **page par page** : la page source pouvait entrer et une page d'entité rester sous `.candidats/`, et la source passait pour ingérée. D'où l'état `candidats`. Une page retenue quitte `.candidats/` : ce qui y reste n'a vraiment pas fini la gate. Angle mort : `check` n'impose pas `sources:` hors des pages `sources/`, une candidate qui ne le remplit pas n'est rattachée à aucune source.

Chaque session tourne sous la garde Kioku avec `VAULT_MODE` et `VAULT_DOMAIN`, comme avec `tools/vault.mjs`.

## Déduplication

Une note n'est **jamais redéposée** si elle est déjà connue, **dans n'importe quel domaine** et **avant le tri**. Le contrôle se fait dans cet ordre (`dedup.mjs`) :

| Étiquette du rapport | Critère |
|---|---|
| `[connu:id]` | l'id Plaud (`of_…`) est dans `seen.json` ou dans un `plaud_id:` de `inbox/`, `inbox/a-trancher/`, `raw/pro/` ou `raw/perso/` |
| `[ecarte:registre]` | l'id est dans `seen.json` avec le domaine `ecarte` (`--skip`) |
| `[connu:nom]` | le nom de fichier existe déjà dans l'un de ces dossiers |
| `[connu:contenu]` | le sha256 du contenu égale celui d'un fichier présent (frontmatter et fins de ligne ignorés) |

Pourquoi l'id : le nom de fichier dérive du titre Plaud, qui change (retitrage, troncature). L'id est la clé, le contenu est le filet.

Chaque nouveau dépôt porte l'id en frontmatter :

```
---
plaud_id: of_…
---
```

### `seen.json`

Registre **versionné** de `{ id, domaine | "ecarte", date }`. Ni titre, ni contenu : il peut être lu sans rien exposer d'un domaine à l'autre. Il couvre ce que les bruts n'expriment pas : les bruts antérieurs à `plaud_id:` (immuables, jamais réécrits) et les notes écartées.

### Amorçage

Une seule fois, pour un coffre dont les bruts n'ont pas d'id :

```
node tools/plaud-sync/fetch-notes.mjs --seed --dry-run    # prévisualise
node tools/plaud-sync/fetch-notes.mjs --seed              # écrit seen.json
```

Il apparie chaque enregistrement à un brut existant (empreinte, puis nom) et consigne `{ id, domaine }`. Ce qui n'est pas apparié est listé sans être consigné. Pour écarter une note pour de bon : `--skip <id>`.

### Ce qui n'est pas couvert

Un brut ancien qui a été retitré **et** dont l'id n'est pas au registre ne se rapproche ni par l'id, ni par le nom, ni par le contenu s'il a changé. Il ressortirait comme nouveau. C'est à ça que sert l'amorçage.

## Fichiers

| Fichier | Rôle |
|---|---|
| `run.mjs` | lanceur : dépôt → tri → ingestion → rapport |
| `fetch-notes.mjs` | dépôt dans `inbox/` via le MCP ; `--list`, `--dry-run`, `--seed`, `--skip` |
| `dedup.mjs` | déduplication : id, nom, empreinte, registre |
| `pending.mjs` | file d'ingestion : ce que le tri vient de ranger et qui n'est pas entré dans l'or |
| `lock.mjs` | verrou du lanceur : un seul `run.mjs` à la fois sur un coffre |
| `seen.json` | registre des ids vus ou écartés (versionné) |
| `exclusions.txt` | ids Plaud à ne jamais déposer, avec le motif en commentaire (versionné) |
| `dedup.test.mjs`, `lock.test.mjs`, `pending.test.mjs`, `thread.test.mjs` | tests de la déduplication, du verrou, de la file et du fil de conversation |
| `.snapshot.json`, `.queue.json`, `.lock.json` | état local, non versionné |

`exclusions.txt` (liste tenue à la main, motif documenté) et `seen.json` (registre tenu par l'outil) coexistent : une exclusion documentée reste dans le premier, un `--skip` va dans le second.

## Tests

```
node --test tools/plaud-sync/*.test.mjs
```

52 tests sur des coffres factices (contenus inventés) : aucun fichier réel n'est lu, aucun modèle n'est appelé.

**Déduplication** (13) : titre tronqué autrement, note retitrée, note écartée, note re-proposée depuis `raw/pro` ou `raw/perso`, note parquée, amorçage.

**Verrou** (15) : prise et libération, refus quand un lanceur vivant le détient, reprise d'un verrou périmé (processus mort, fichier tronqué, sans PID), libération qui n'efface pas le verrou d'un autre, deux coffres indépendants.

**File** (15) : les trois marches (`neuf` → `argent` → sortie de file), et ce que la page or doit prouver pour compter — bon brut, bon domaine, bien dans `sources/`. `heritage/` n'est pas parcouru.

**Fil de conversation** (9) : les arguments réellement passés à `claude`, via un faux binaire placé en tête de `PATH` — une source par tour, `--session-id` puis `--resume` sur une même journée, froid pour une source isolée, et le fil abandonné quand un tour échoue.
