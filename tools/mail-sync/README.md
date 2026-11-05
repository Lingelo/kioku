# mail-sync

Circuit **mail → coffre** : les fils Gmail portant un libellé choisi (opt-in, `kb` par défaut) arrivent dans `inbox/`, sont triés vers `raw/<domaine>/emails/` (PDF joints : `raw/<domaine>/pdfs/`), puis ingérés bronze → argent → or. Le circuit est celui de tous les connecteurs ([`tools/connectors/`](../connectors/README.md)) ; ce dossier n'apporte que le dépôt.

Lancé par l'utilisateur, jamais planifié, depuis le checkout principal. Guide : [Capture modules](../../docs/guide/08-capture.md#mail).

## Lancer

```
npm run mail:login -- <compte>                 # une fois par compte, depuis un terminal
npm run mail:sync                              # 7 derniers jours, tous les comptes
npm run mail:sync -- --account travail --since 2026-11-01
npm run mail:dry-run
npm run mail:pending                           # tri + ingestion de ce qui attend
npm run mail:sync -- --skip <thread_id>        # écarte un fil pour de bon
npm run mail:drop -- <fichier>                 # écarte une source parquée (et son PDF)
npm run mail:sync -- --max-pdf-mb 10
```

## Ce qui est fait, et ce qui ne l'est pas

- **Lecture seule** : scope `gmail.readonly`. Le libellé n'est jamais retiré ; ce qui est déjà capté se lit dans le coffre (fichiers et `seen.json`).
- **Unité = le fil.** Un `.md` par fil ; chaque **PDF joint** est une source à part (`<date>-<nom>-<sha8>.pdf` + sa fiche `.pdf.md`, `attachment_of:` vers le fil). Autres pièces jointes : ignorées, listées au rapport et dans le fil. PDF au-delà de `--max-pdf-mb` (défaut 20, ou `modules.mail.max_pdf_mb`) : ignoré et signalé, **sans être téléchargé**.
- **Réponse tardive = suite.** Un fil déjà capté qui reçoit une réponse donne un nouveau fichier `…-suite-<id>.md`, avec les seuls messages nouveaux (`suite_of:`, `previous_message_id:`). Le bronze n'est jamais réécrit.
- **Dédup** : par fil et par messages couverts (`message_ids:` des fichiers déposés, entrées `msgs:` du registre), puis par empreinte du contenu (`body_sha256:`) et des PDF (`attachment_sha256:`). `--skip` consigne `thread:<id>`, `--drop` consigne `msgs:<fil>:<ids>` ou `att:<sha>`.
- **Corps non fiable** : entre `<untrusted-mail-data-NONCE>` et sa fermeture, NONCE aléatoire par fichier ; toute occurrence du préfixe dans le contenu est neutralisée. Sujet et participants : chaînes JSON en frontmatter. Le titre `#` est généré, sans rien du mail.
- **Nettoyage** : citations en cascade retirées (lignes `>`, « Le … a écrit : », « On … wrote: », séparateurs Outlook), un transfert gardé ; signature au-delà de 4 lignes tronquée avec mention.

## Jeton et client OAuth

Hors du coffre : `~/.config/kioku/mail/` (`$XDG_CONFIG_HOME`, `%APPDATA%` sous Windows). `client.json` = le client « Desktop » créé par l'utilisateur ; `<compte>.json` = son jeton, écrit en 0600 (fichier temporaire puis renommage, dossier 0700). Sous Windows, les modes POSIX sont sans effet : la protection est celle du profil utilisateur. Le jeton n'est jamais affiché, journalisé, ni passé à une session.

Connexion : PKCE S256, boucle locale `127.0.0.1` (port choisi par le système), `state` vérifié (un mauvais `state` reçoit 400, on continue d'attendre), délai 5 minutes. Rafraîchissement automatique ; `invalid_grant` → message « relance `mail:login` ».

## Fichiers

| Fichier | Rôle |
|---|---|
| `run.mjs` | point d'entrée (`kioku mail`) : connecteur branché sur `connectors/circuit.mjs`, `--login` |
| `fetch-mail.mjs` | dépôt de tous les comptes (lancé par le circuit), `--skip` |
| `capture.mjs` | dépôt d'un compte : classement, PDF, écriture exclusive |
| `bronze.mjs` | rendu du fil et de la fiche PDF |
| `dedup.mjs` | registre `seen.json`, photo des dépôts, classement d'un fil |
| `clean.mjs` | citations et signatures |
| `mime.mjs` | MIME sans dépendance : multipart, base64url, quoted-printable, charsets, RFC 2047 / 2231, HTML → texte |
| `oauth.mjs`, `paths.mjs`, `http.mjs` | OAuth, emplacements hors coffre, requêtes avec relances bornées (429, 5xx) |
| `providers/gmail.mjs` | fournisseur Gmail : `listThreads(label, since)`, `getThread(id)`, `getAttachment(msgId, attId)` |
| `fixtures.mjs` | faux Gmail des tests |

Un autre fournisseur (IMAP) implémente la même interface et se déclare dans `PROVIDERS` (`fetch-mail.mjs`) et `MAIL_PROVIDERS` (`hooks/config.mjs`) ; `mime.mjs` (`parseRaw`) lit déjà un message brut.

## Non vérifié contre l'API réelle

Les tests simulent l'API ; aucun appel réel n'a été fait. Deux points reposent sur la documentation et l'usage courant, à confirmer au premier lancement réel :

- `threads.get?format=full` rend `body.data` **déjà décodé du transfert** (base64 / quoted-printable) : le fournisseur ne le décode pas une seconde fois. Le charset déclaré est appliqué ; un charset latin déclaré sur des octets UTF-8 valides est lu en UTF-8.
- La requête `after:AAAA/MM/JJ` combinée à `labelIds` liste les fils ayant un message depuis cette date.
