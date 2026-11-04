# Cheat sheet

[← Contents](README.md)

`<D>` = a domain of your `kioku.config.json`.

## Sessions

```
npm run <D>                  ask the wiki (query)
npm run ingest:<D>           ingest (lists what is left, asks)
npm run lint:<D>             review the wiki and decide the quarantine
npm run triage               sort the inbox
npm run setup                configure (add-domain, upgrade, doctor)
npm run vault                query, domain asked
kioku session <D> -- --resume
```

## Inside a session

```
/kioku:query <question>      (or a plain question)
/kioku:save [slug]           file the last answer as a synthesis
/kioku:ingest [file…]        ingest
/kioku:lint [<D>]            review
/kioku:triage [file]         sort
/kioku:setup [create|check|upgrade|install|plaud]
/kioku:add-domain [name]
```

## Gate and quarantine

```
kioku check <files…>                          deterministic check
kioku promote <files…>                        enter gold (ok verdict required)
kioku stage <D> <folder/slug>                 copy a gold page to edit it (ingest session)
kioku undecided [<D>]                         what waits: nature, code, allowed actions
kioku decide <D> <name> keep|correct|drop [note]
kioku flag <D> <folder/slug> <code> [note]    flag a gold page
kioku audit <D>                               deterministic anomalies
kioku rotate-log <D> [--dry-run]              archive past months of the log
```

## Tools

```
npm run dashboard:<D>        static HTML
npm run dashboard:serve:<D>  local server (Ctrl-C)
npm run dashboard:all        every domain (outside a session)
npm run plaud:sync           Plaud → gold (confirmation per domain)
npm run plaud:dry-run        what would be dropped
npm run plaud:pending        resume the inbox / the queue
npm run plaud:drop -- <f>    drop a parked source
```

## Maintenance

```
kioku doctor [--live]        proof of isolation
kioku upgrade [--write]      current shape of init (simulation by default)
kioku add-domain <name> [--preset minimal|pro|perso] [--description "…"]
claude plugin update kioku@<marketplace> [--scope user]
```

## Never

- export `VAULT_MODE` / `VAULT_DOMAIN` in your shell;
- write straight under `wiki/` (except `index.md`, `log.md`, `overview.md` by the session);
- push the vault to a public remote;
- file a source "to go faster".
