# 7. Dashboard

[← Contents](README.md)

A view of the vault's state: medallion progress (linked bronze, silver, gate), an action queue by severity, a 3D graph of the gold pages, a user manual.

## Launching

| Command | Effect |
|---|---|
| `npm run dashboard:<D>` | writes a static HTML file (`tools/dashboard/dashboard-<D>.html`) |
| `npm run dashboard:serve:<D>` | local server in the foreground, URL printed; **Ctrl-C** to stop it |
| `npm run dashboard:all` | every domain (outside a session only) |
| `npm run dashboard` · `dashboard:serve` | the first declared domain |

## What the server guarantees

- Listens **only** on `127.0.0.1`, `Host` header checked, no cross-origin read.
- **One domain per process.** From a session, `all` and the other domains are refused.
- The server writes nothing. The question field starts a `claude -p` session in `query` mode, **under the guard**: that session, and only it, can write (log, index, `/kioku:save` candidates), as on the command line.

## The action queue

Each row offers a command to copy.

| Category | Command offered |
|---|---|
| Quarantine, pointer | `kioku decide <D> <name> drop` |
| Quarantine, held or flagged page | `kioku decide <D> <name>` **without an action**: add `keep`, `correct` or `drop`. No default `drop`: it would delete a page. |
| Waiting candidate | `kioku check …` |
| Bronze without gold | `npm run ingest:<D> -- "/ingest <file>"` |
| Anomalies | `npm run audit:<D>` |

## Watch out

- **The generated HTML holds the wiki in clear text.** The `tools/dashboard/dashboard-*.html` pattern is in the managed `.gitignore` block: don't version it, don't share it.
- The video of the user manual tab is not versioned; without it, the player is empty.
