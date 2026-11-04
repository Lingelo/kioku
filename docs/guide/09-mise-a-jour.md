# 9. Mettre à jour Kioku

[← Sommaire](README.md)

## Le plugin

Le coffre ne porte pas de version du plugin, seulement un **numéro de format** (`format` dans `kioku.config.json`).

```bash
claude plugin update kioku@<marketplace>                 # met à jour UNE portée (projet si lancé dans un coffre)
claude plugin update kioku@<marketplace> --scope user    # la portée utilisateur, à faire aussi
```

Puis **redémarrez les sessions** : la garde est chargée au démarrage, une session ouverte garde l'ancienne.

Vérifier :

```bash
kioku doctor --live          # la garde chargée refuse bien une lecture vers un autre domaine
```

- Un plugin **trop ancien** pour le format du coffre refuse de démarrer et donne la commande de mise à jour.
- Un plugin **plus récent** lit les coffres plus anciens ; `kioku upgrade` les amène à la forme courante.
- Si l'auto-update de la marketplace est activé (`/plugin` › Marketplaces), la mise à jour arrive seule, à son rythme.

## `kioku upgrade`

Ramène le coffre à ce que produit `kioku init` aujourd'hui, sans toucher à vos données.

```bash
kioku upgrade            # simulation : montre le diff
kioku upgrade --write    # l'applique (idempotent)
```

| Fichier | Ce qui est réécrit |
|---|---|
| `package.json` | les scripts dont la valeur commence par `kioku ` ; vos autres scripts restent |
| `.gitignore` | le bloc `# >>> kioku` … `# <<< kioku` |
| `.claude/settings.json` | l'activation du plugin |
| `kioku.config.json` | ajouts seulement (`format`, `default_session`, `modules`) |
| `.kioku/schema.md` | entier |

Jamais touchés : `wiki/`, `raw/`, `silver/`, `CLAUDE.md`, `domains/*/rules.md`, le registre des organisations.

## Ajouter un domaine

```bash
npm run setup
> /kioku:add-domain asso
```

Ou depuis un terminal : `kioku add-domain asso --preset minimal --description "La vie de l'association"`. Le domaine est créé sans toucher aux autres, la configuration écrite en dernier, puis le cloisonnement est prouvé sur tous les domaines. Les règles (`domains/asso/rules.md`) s'adaptent à la main, hors session. Retirer ou renommer un domaine se fait à la main, puis `kioku doctor`.

## Nouvelle machine

1. Installer le plugin (README), et le relais `kioku` dans le PATH si vous lancez les sessions depuis un terminal.
2. `git clone <remote privé> <dossier>` : configuration, règles et registre arrivent avec le coffre.
3. `cd <dossier> && claude`, accepter le dossier, `/exit` ; puis `kioku doctor --live`.

**L'entrant ne voyage pas** (`inbox/` n'est pas versionné) : triez-le avant de quitter l'ancienne machine.

## Le journal

`wiki/<D>/log.md` ne garde que le mois courant. Le lint propose la rotation des mois révolus vers `wiki/<D>/log/<AAAA-MM>.md` (`kioku rotate-log <D>`), vous validez. Les entrées sont déplacées à l'octet près.
