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
| a path through a symbolic link, `~`, or in another letter case refused | intended: the guard judges the file the system will really open (link target, home directory expanded, case folded on a case-insensitive volume such as macOS APFS or NTFS) | use the real path in your own domain |

**No session can modify the guard.** If it keeps blocking wrongly, that's a core defect to report, not to work around.

### `node` not found by Claude Code

The guard is a hook command run by Claude Code's shell. If that shell can't find the interpreter, it exits with `127`, and Claude Code treats a hook that fails that way as **non-blocking**: the session would run without the guard. Both hook forms are now written to fail closed instead:

| Hook | Interpreter | If it can't be found |
|---|---|---|
| plugin (`hooks/hooks.json`) | `node`, looked up in Claude Code's `PATH` | `\|\| exit 2`: every tool call is refused, the stderr says `node: command not found` |
| project (`kioku init --guard-hook`) | absolute path of the Node that ran `init` (`process.execPath`) | same `\|\| exit 2` fallback; `kioku doctor` and the launcher report `interpreteur du hook de garde introuvable` |

Limit, stated: the plugin's `hooks.json` ships to other machines, so it **cannot** carry an absolute interpreter path. `kioku doctor` and the launcher (`npm run <domain>`, `kioku session`) check that `node` is in **their** `PATH`, which a session they start inherits. A session opened another way (desktop app, IDE, a shell with a different profile) can have a shorter `PATH`: there the fallback refuses everything rather than letting the session run unguarded. Fix: make `node` visible to Claude Code (a system location such as `/usr/local/bin/node`, or launch Claude Code from a terminal where `node -v` works), then `kioku doctor --live`.

A vault created before this fix with `--guard-hook` keeps a `node "…/guard.mjs"` hook without the fallback: `kioku doctor` says so and prints the command to put in `.claude/settings.json`. Upgrading a version manager (nvm, fnm, volta) can remove the absolute path the hook names: the guard then refuses everything, `kioku doctor` names the missing interpreter.

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

## Mail

| Symptom | Fix |
|---|---|
| "client OAuth absent" | create a Desktop OAuth client and save its JSON as `~/.config/kioku/mail/client.json` ([Capture modules](08-capture.md#mail)) |
| "pas de jeton" / "rafraichissement du jeton refuse" | `npm run mail:login -- <account>` from a terminal (in Testing mode, Google expires the token after 7 days) |
| the login page says the app is blocked | a Workspace administrator blocks unverified apps: nothing to fix locally; ask them, or wait for the IMAP provider |
| "libelle Gmail introuvable" | create the label in Gmail (default `kb`) or fix `label` in `modules.mail.accounts` |
| a PDF is "ignoree" in the report | over the size limit (`--max-pdf-mb`, `max_pdf_mb`) or not a PDF: only PDFs become sources |
| `kioku.config.json` invalid after adding an account | `hint.domain` must be declared, `hint.org` in that domain's registry, `id` kebab-case and unique |
