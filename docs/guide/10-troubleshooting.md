# 10. Troubleshooting

[← Contents](README.md)

Always start with:

```bash
kioku doctor --live
```

| Code | Meaning | What to do |
|---|---|---|
| `0` | isolation proven | nothing |
| `1` (`ECHEC`) | a prerequisite or a file is missing | the output gives the command |
| `3` (`CLOISONNEMENT`) | guard missing, disabled, doubled or letting things through | **fix before any use**: plugin installed and enabled, no `disableAllHooks` |

Kioku's messages are in French; the quoted fragments below are what you'll see.

## The guard

| Symptom | Likely cause | Fix |
|---|---|---|
| everything refused in a project **outside** a vault | `VAULT_MODE` or `VAULT_DOMAIN` exported in your shell | `unset VAULT_MODE VAULT_DOMAIN`, and remove the export from your profile |
| everything refused in the vault | unreadable configuration: the vault is treated as damaged | `kioku doctor` says what |
| "recherche recursive sans dossier autorise" | a `grep -r` or a search without a path | give a precise path in the domain (`wiki/<D>/…`) |
| "l'historique git contient le brut et tous les domaines" | `git show`, `git log -p`, `git diff`, `git grep`… | read the domain's files, not the history; diff yourself, outside any session |
| "elle nomme une zone fermee" | a command names `quarantine/`, `raw/`… (even inside text) | if it's a false positive: write the command into a script outside the vault and run it |
| `git commit` refused in a session | intended | commit yourself, in your terminal |
| a write under `wiki/` refused | intended: gold goes through the gate | a candidate under `.candidats/`, or `kioku stage` for an existing page |

**No session can modify the guard.** If it keeps blocking wrongly, that's a core defect to report, not to work around.

## The gate

| Symptom | Cause | Fix |
|---|---|---|
| `refusee … : …` | format, frontmatter, provenance | fix what `check` names |
| `sans verdict` | the page changed since review, or no reviewer judged it | run the reviewer again on the current version |
| `sans verdict … pour le domaine` | verdict given from a session of another domain | run the reviewer again from a session of the page's domain |
| `retenue … (code …)` | verdict `hold` | don't rewrite; decide at the lint (see [6](06-lint-quarantine.md)) |
| `en attente de decision` at `stage` or `tag-org` | the page has a quarantine entry | decide it first, at the lint |
| `un pointeur de source ecartee ne se promeut pas` | `keep` or `correct` on a **pointer** | a pointer is only decided by `drop` |
| candidates linger under `.candidats/` | the ingestion stopped before the gate | run `check` → reviewer → `promote` again; nobody else sees them |

## The plugin and the relay

| Symptom | Fix |
|---|---|
| "exige le format N" (requires format N) | plugin too old: `claude plugin update kioku@<marketplace>` (both scopes), restart |
| `kioku: command not found` | relay missing from your PATH: the plugin's install script (README) |
| the relay picks a clone instead of the plugin | `KIOKU_HOME` is set; it says so on stderr. `unset KIOKU_HOME` |
| the old behaviour persists after an update | the session was opened before: restart it |
| only one scope is up to date | `claude plugin update` updates one scope: run it again with `--scope user` (or the reverse) |

## Plaud

| Symptom | Fix |
|---|---|
| authentication refused | `npx -y @plaud-ai/mcp@latest` to redo the OAuth |
| "verrou pris" (lock taken) | a circuit is already running on this machine: wait. A lock whose process is gone (killed, machine restarted) is taken over automatically, nothing to delete. The lock is local: two machines don't see each other |
| exit code `2` at the end | normal: sources are left to resume (`plaud:pending`) or to route (`inbox/a-trancher/`) |
| refused in a worktree | run from the main checkout, or `--allow-worktree` |
