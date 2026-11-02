# Kioku

Un coffre de connaissance pour [Claude Code](https://docs.claude.com/en/docs/claude-code), sur le modèle *LLM Wiki* : vous déposez des sources brutes, Claude maintient un wiki structuré, et un schéma fixe les règles. Kioku ajoute trois garanties tenues par du code, pas par une consigne :

- **Médaillon** : bronze (`raw/`, la source telle qu'elle est entrée, immuable) → argent (`silver/`, une fiche nettoyée par source) → or (`wiki/`, les pages). On ne requête que l'or.
- **Silos** : un coffre a plusieurs domaines (par exemple `travail` et `perso`). Une session est ouverte sur un seul domaine ; un hook `PreToolUse` refuse toute lecture ou écriture dans un autre.
- **Gate** : aucune page n'entre dans l'or sans un contrôle déterministe (format, provenance, secrets) puis un verdict d'un relecteur distinct du rédacteur, lié à l'empreinte exacte de la page.

Le core (ce dépôt) ne contient aucune donnée. Votre coffre est un dossier à part, dans votre propre dépôt privé.

## Prérequis

- Node.js 20 ou plus, git
- Claude Code installé et authentifié

## Installation

```bash
git clone https://github.com/<vous>/kioku.git ~/kioku
ln -s ~/kioku/bin/kioku ~/.local/bin/kioku    # ou tout dossier de votre PATH
```

Puis, dans Claude Code, installez le plugin depuis ce clone (`/plugin`, marketplace locale), ou lancez une session avec `claude --plugin-dir ~/kioku`.

## Créer un coffre

```bash
kioku init ~/mon-coffre --domains travail,perso
cd ~/mon-coffre
kioku doctor --live
```

`init` crée la configuration (`kioku.config.json`), le squelette de chaque domaine, ses règles (`domains/<D>/rules.md`, à partir d'un preset), le schéma commun (`.kioku/schema.md`) et un `CLAUDE.md` qui l'importe. `doctor` prouve le cloisonnement : il sonde la garde pour chaque paire de domaines, et `--live` ouvre une vraie session qui doit être refusée en lisant un autre domaine.

Ajouter un silo plus tard : `kioku add-domain <nom> [--preset minimal|pro|perso]`, ou `/kioku:add-domain` dans une session `setup`.

## Au quotidien

| Besoin | Commande |
|---|---|
| Poser une question au wiki | session `query` sur le domaine, puis `/kioku:query …` ou une question libre |
| Faire entrer une source | la déposer dans `raw/<D>/…`, session `ingest`, `/kioku:ingest <fichier>` |
| Ranger l'entrant | session `triage`, `/kioku:triage` |
| Relire le wiki | `/kioku:lint <D>` en session `query` |
| Filer une analyse durable | `/kioku:save` |

Une session se lance avec `VAULT_MODE` (`query`, `ingest`, `triage`, `setup`) et `VAULT_DOMAIN` ; `node ~/kioku/tools/vault.mjs --domain <D> [--mode ingest]` les pose pour vous.

## Modules optionnels

- **Dashboard** (`tools/dashboard/`) : état du médaillon, graphe 3D de l'or, et questions au wiki depuis un navigateur local. La vidéo de présentation de l'onglet Mode d'emploi n'est pas versionnée (trop lourde) : sa source est `tools/dashboard/video/` ; déposez le rendu dans `tools/dashboard/vendor/media/kioku-explainer.mp4`.
- **Plaud** (`tools/plaud-sync/`) : dépose les notes d'un enregistreur Plaud dans l'entrant, les trie par domaine, demande confirmation, puis les ingère.

## Ce que la garde ne fait pas

- Elle filtre les outils de Claude Code, pas vos propres commandes dans un terminal.
- Elle juge le texte des commandes shell, pas leurs effets : elle bloque des formes connues, elle ne sandboxe pas.
- La gate vérifie la provenance, pas la vérité ; le relecteur est un autre appel de modèle dans la même session.

## Contribuer

`npm install` branche un hook `pre-push` qui refuse tout push portant un terme d'une liste privée (`KIOKU_DENYLIST`, un fichier hors du dépôt). Les tests : `npm test`.

## Licence

MIT
