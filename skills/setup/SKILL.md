---
name: setup
description: Créer un coffre dans un dossier vide, ou vérifier, mettre à jour et réparer un coffre existant (prérequis, configuration, garde, domaines, capture Plaud). À lancer explicitement.
argument-hint: [create|check|upgrade|install|plaud]
disable-model-invocation: true
---

Tu aides l'utilisateur à créer, installer ou réparer un coffre. Étape demandée : $ARGUMENTS.

**Choisis d'abord le cas** (sans argument) : s'il n'y a pas de `kioku.config.json` dans le dossier courant et que le dossier est vide (ou ne contient que `.git`), c'est `create`. Sinon, `check`, puis propose la suite.

Deux contextes possibles, tous deux sûrs :
- **Dossier vide, hors coffre** (`create`) : la garde ne s'y applique pas (rien à protéger encore). Tu ne lis rien d'autre que ce dossier.
- **Coffre existant, en session `setup`** (`npm run setup`) : tu lis la configuration (`kioku.config.json`) et le registre des organisations, **jamais un contenu de domaine** (wiki, brut, argent, règles, entrant, quarantaine). La garde te le ferme, ce n'est pas une panne. Tu ne lances ni la gate, ni le circuit Plaud, ni le dashboard, ni une session d'un autre mode.

**Tu n'écris jamais la configuration toi-même.** Toute modification passe par le CLI du coffre, qui crée sans rien écraser puis prouve le cloisonnement :

- `kioku doctor` : diagnostic, lecture seule ;
- `kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud]` : crée un coffre dans un dossier vide ;
- `kioku upgrade` : montre le diff qui amènerait le coffre à la forme courante (lecture seule) ; `kioku upgrade --write` l'applique ;
- `kioku add-domain <nom> [--preset <preset>] [--description <texte>]` : ajoute un domaine (skill `/add-domain`).

Avant chaque commande qui écrit, **montre ce qui va être créé et attends un « oui » explicite.** Après, rapporte la sortie de `doctor` telle quelle, en commençant par le cloisonnement.

## create — nouveau coffre dans ce dossier

1. Vérifie que le dossier courant est vide (seul `.git` est toléré ; sinon, arrête-toi et dis pourquoi : `init` n'écrase jamais rien).
2. Demande, une question à la fois : les silos (noms kebab-case, par exemple `pro,perso` ; un preset existe pour `pro`, `perso`, et `minimal` pour tout autre nom), le silo qui porte l'extension `org` s'il y en a un (registre employeur et clients), et si le module Plaud est voulu.
3. Montre la commande `kioku init . --domains … [--org …] [--plaud]` et ce qu'elle crée : configuration et format, squelette par silo (`index.md`, `log.md`, `overview.md`), règles depuis les presets, registre, schéma, `CLAUDE.md`, `package.json` aux scripts par silo (`npm run <silo>`, `ingest:<silo>`, `dashboard:<silo>`…), `.gitignore`, `.gitattributes`, et l'activation du plugin dans `.claude/settings.json`. Attends le « oui ».
4. Lance-la et rapporte sa sortie, en commençant par le cloisonnement. Puis dis à l'utilisateur de **relancer Claude dans ce dossier** (`/exit`, puis `npm run <premier silo>`) : la garde du coffre s'applique à partir de la session suivante.
5. Rappelle : remplir le registre et compléter `CLAUDE.md` à la main, hors session ; les règles de silo sont un point de départ ; un remote git doit être **privé**.

## upgrade — mettre un coffre à la forme courante

1. Lance `kioku upgrade` (simulation) et montre le diff tel quel. Il ne touche que les parties gérées (scripts `kioku …`, bloc `# >>> kioku` du `.gitignore`, activation du plugin dans les settings, ajouts à la configuration, schéma), jamais les données, `CLAUDE.md`, les règles ni le registre.
2. Attends le « oui », puis `kioku upgrade --write`, et rapporte la sortie de `doctor`.

## check — diagnostic (lecture seule)

1. Lance `kioku doctor` et rapporte :
   - **code 3 (`CLOISONNEMENT`)** : la garde est absente, désactivée ou laisse passer. C'est la panne la plus grave : dis-le **en premier**, avec la ligne exacte, et propose la correction (installer le plugin `kioku@dojo`, retirer `disableAllHooks`). Ne propose rien d'autre tant qu'elle n'est pas corrigée ;
   - **« exige le format N »** : le plugin installé est plus ancien que ce coffre : `claude plugin update kioku@dojo` ;
   - **code 1 (`ECHEC`)** : un prérequis ou un fichier manque (Node ≥ 20, git, règles d'un domaine, squelette). Donne la commande qui corrige ;
   - **code 0** : cloisonnement prouvé. Résume les notes (garde utilisée, nombre de sondes et de domaines).
2. Remote git : `git remote -v`. **Refuse tout `git remote add` sans confirmation que le remote est privé** (`gh repo view <repo> --json isPrivate`).
3. `npm test` : le moteur est au vert.

## install — nouvelle machine ou nouveau coffre

Demande d'abord lequel des deux cas s'applique.

**Machine neuve** : le plugin s'installe une fois, au niveau utilisateur (`claude plugin marketplace add <owner>/dojo`, puis `claude plugin install kioku@dojo --scope user`) ; pour `npm run` depuis un terminal, le relais `kioku` se pose par `sh scripts/install.sh <owner>/dojo` du plugin. Donne ces commandes à l'utilisateur (`!`), tu ne les lances pas.

**Coffre existant, machine neuve** : le dépôt du coffre arrive par `git clone <remote privé> <dossier>`. La configuration, les règles et le registre viennent avec lui : rien à créer. Lance `check`. Le contenu de `inbox/` ne voyage jamais : il faut le trier (`/triage`) avant de changer de machine.

**Coffre neuf** : étape `create`.

## plaud — capture des réunions

Le module Plaud dépose dans `inbox/` ; `/triage` classe ensuite dans un domaine déclaré, ou s'abstient. Tu n'exécutes rien de ce circuit en session `setup` : donne les commandes à l'utilisateur.

1. **Connexion (une fois par machine)** : `! npx -y @plaud-ai/mcp@latest`, puis l'OAuth dans le navigateur (le jeton reste dans `~/.plaud/`).
2. **Exclure un enregistrement** (perso, RH d'une autre organisation) : son identifiant `of_…` dans `tools/plaud-sync/exclusions.txt`, avec un commentaire.
3. **Circuit complet**, depuis le coffre et hors session : `npm run plaud:sync` (ou `plaud:dry-run`). Il enchaîne dépôt, tri, confirmation, ingestion et rapport ; chaque étape reste sous la garde.

## Règles

- Jamais d'écriture directe de la configuration, des règles de domaine, du registre ni des settings : CLI ou main de l'utilisateur.
- Aucun retrait ni renommage de domaine : cela se fait à la main, hors session, puis `doctor`.
- Jamais de push vers un remote public ; ne contourne pas la garde.
- Rapporte à la fin : ce qui est prêt, ce qui manque, ce que l'utilisateur doit lancer lui-même (`!`).
