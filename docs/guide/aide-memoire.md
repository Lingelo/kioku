# Aide-mémoire

[← Sommaire](README.md)

`<D>` = un domaine de votre `kioku.config.json`.

## Sessions

```
npm run <D>                  question au wiki (query)
npm run ingest:<D>           ingérer (liste ce qui reste, demande)
npm run lint:<D>             relire le wiki et trancher la quarantaine
npm run triage               ranger l'entrant
npm run setup                configurer (add-domain, upgrade, doctor)
npm run vault                query, domaine demandé
kioku session <D> -- --resume
```

## Dans une session

```
/kioku:query <question>      (ou une question libre)
/kioku:save [slug]           filer la dernière réponse en synthèse
/kioku:ingest [fichier…]     ingérer
/kioku:lint [<D>]            relire
/kioku:triage [fichier]      trier
/kioku:setup [create|check|upgrade|install|plaud]
/kioku:add-domain [nom]
```

## Gate et quarantaine

```
kioku check <fichiers…>                       contrôle déterministe
kioku promote <fichiers…>                     entrée dans l'or (verdict ok requis)
kioku stage <D> <dossier/slug>                copier une page de l'or pour la modifier (session ingest)
kioku undecided [<D>]                         ce qui attend : nature, code, actions admises
kioku decide <D> <nom> keep|correct|drop [note]
kioku flag <D> <dossier/slug> <code> [note]   signaler une page de l'or
kioku audit <D>                               anomalies déterministes
kioku rotate-log <D> [--dry-run]              archiver les mois révolus du journal
```

## Outils

```
npm run dashboard:<D>        HTML statique
npm run dashboard:serve:<D>  serveur local (Ctrl-C)
npm run dashboard:all        tous les domaines (hors session)
npm run plaud:sync           Plaud → or (confirmation par domaine)
npm run plaud:dry-run        ce qui serait déposé
npm run plaud:pending        reprendre l'entrant / la file
npm run plaud:drop -- <f>    écarter une source parquée
```

## Maintenance

```
kioku doctor [--live]        preuve du cloisonnement
kioku upgrade [--write]      forme courante d'init (simulation par défaut)
kioku add-domain <nom> [--preset minimal|pro|perso] [--description "…"]
claude plugin update kioku@<marketplace> [--scope user]
```

## Ne jamais

- exporter `VAULT_MODE` / `VAULT_DOMAIN` dans son shell ;
- écrire directement sous `wiki/` (sauf `index.md`, `log.md`, `overview.md` par la session) ;
- pousser le coffre vers un remote public ;
- ranger une source « pour aller vite ».
