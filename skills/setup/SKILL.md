---
name: setup
description: Installer, vérifier ou réparer un coffre (prérequis, configuration, garde, domaines, capture Plaud). Session lancée avec VAULT_MODE=setup. À lancer explicitement, sur une machine neuve ou quand quelque chose ne marche plus.
argument-hint: [check|install|plaud]
disable-model-invocation: true
---

Tu aides l'utilisateur à installer ou réparer le coffre. Étape demandée : $ARGUMENTS (défaut : `check`, puis propose la suite).

Tu es en **session `setup`** (`npm run setup`) : tu lis la configuration (`kioku.config.json`) et le registre des organisations, **jamais un contenu de domaine** (wiki, brut, argent, règles, entrant, quarantaine). La garde te le ferme, ce n'est pas une panne. Tu ne lances ni la gate, ni le circuit Plaud, ni le dashboard, ni une session d'un autre mode.

**Tu n'écris jamais la configuration toi-même.** Toute modification passe par le CLI du coffre, qui crée sans rien écraser puis prouve le cloisonnement :

- `kioku doctor` : diagnostic, lecture seule ;
- `kioku init <dossier> [--domains a,b] [--org <domaine>] [--plaud]` : crée un coffre dans un dossier vide ;
- `kioku add-domain <nom> [--preset <preset>] [--description <texte>]` : ajoute un domaine (skill `/add-domain`).

Avant chaque commande qui écrit, **montre ce qui va être créé et attends un « oui » explicite.** Après, rapporte la sortie de `doctor` telle quelle, en commençant par le cloisonnement.

## check — diagnostic (lecture seule)

1. Lance `kioku doctor` et rapporte :
   - **code 3 (`CLOISONNEMENT`)** : la garde est absente, désactivée ou laisse passer. C'est la panne la plus grave : dis-le **en premier**, avec la ligne exacte, et propose la correction (brancher le hook dans `.claude/settings.json`, retirer `disableAllHooks`). Ne propose rien d'autre tant qu'elle n'est pas corrigée ;
   - **code 1 (`ECHEC`)** : un prérequis ou un fichier manque (Node ≥ 20, git, règles d'un domaine, squelette). Donne la commande qui corrige ;
   - **code 0** : cloisonnement prouvé. Résume les notes (garde utilisée, nombre de sondes et de domaines).
2. Remote git : `git remote -v`. **Refuse tout `git remote add` sans confirmation que le remote est privé** (`gh repo view <repo> --json isPrivate`).
3. `npm test` : le moteur est au vert.

## install — nouvelle machine ou nouveau coffre

Demande d'abord lequel des deux cas s'applique.

**Coffre existant, machine neuve** : le dépôt du coffre arrive par `git clone <remote privé> <dossier>`. La configuration, les règles, la garde et le registre viennent avec lui : rien à créer. Lance `check`. Le contenu de `inbox/` ne voyage jamais : il faut le trier (`/triage`) avant de changer de machine.

**Coffre neuf** :
1. Demande, une question à la fois : le dossier cible (il doit être vide), les domaines (noms kebab-case ; un preset existe pour `pro`, `perso`, et `minimal` pour tout autre nom), le domaine qui porte l'extension `org` s'il y en a un (registre employeur et clients), et si le module Plaud est voulu.
2. Montre la commande `kioku init …` et ce qu'elle crée (configuration, squelette par domaine, règles depuis les presets, registre, `.gitignore`, garde branchée), puis attends le « oui ».
3. Lance-la et rapporte sa sortie. Si un registre a été créé, rappelle qu'il faut le remplir **à la main, hors session** (la garde le ferme aux sessions) : tant qu'il contient l'employeur générique, `check` refuse les pages de ce domaine.
4. Rappelle que les règles de chaque domaine (`domains/<domaine>/rules.md`) sont un point de départ, à adapter à la main, hors session.

## plaud — capture des réunions

Le module Plaud dépose dans `inbox/` ; `/triage` classe ensuite dans un domaine déclaré, ou s'abstient. Tu n'exécutes rien de ce circuit en session `setup` : donne les commandes à l'utilisateur.

1. **Connexion (une fois par machine)** : `! npx -y @plaud-ai/mcp@latest`, puis l'OAuth dans le navigateur (le jeton reste dans `~/.plaud/`).
2. **Exclure un enregistrement** (perso, RH d'une autre organisation) : son identifiant `of_…` dans `tools/plaud-sync/exclusions.txt`, avec un commentaire.
3. **Circuit complet**, depuis le checkout principal et hors session : `node tools/plaud-sync/run.mjs [--since <date>] [--dry-run]`. Il enchaîne dépôt, tri, confirmation, ingestion et rapport ; chaque étape reste sous la garde.

## Règles

- Jamais d'écriture directe de la configuration, des règles de domaine, du registre ni des settings : CLI ou main de l'utilisateur.
- Aucun retrait ni renommage de domaine : cela se fait à la main, hors session, puis `doctor`.
- Jamais de push vers un remote public ; ne contourne pas la garde.
- Rapporte à la fin : ce qui est prêt, ce qui manque, ce que l'utilisateur doit lancer lui-même (`!`).
