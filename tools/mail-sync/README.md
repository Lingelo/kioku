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

## Jeton et client OAuth : au trousseau

Par défaut (`modules.mail.secretStore: "keychain"`), le jeton de chaque compte (`token:<compte>`) et le client OAuth (`client`) sont au **trousseau du système**, service `kioku-mail` (`secret-store.mjs`) : plus aucun fichier lisible par une session ne donne accès à la boîte.

- macOS : `security`. Écriture par `security -i` (commandes lues sur l'entrée standard) avec `-X <hex>` : le secret ne passe jamais en argument d'un processus (`ps`). Lecture : `find-generic-password -w`.
- Linux : `secret-tool` ; le secret passe sur l'entrée standard de `store`. Sans service de secrets (D-Bus), repli fichier.
- Windows : `cmdkey` écrit mais ne relit pas le secret, et `CredRead` exigerait PowerShell + `Add-Type`, non testé ici : **repli fichier**, dit à chaque lancement.

`client.json` (`~/.config/kioku/mail/`, `$XDG_CONFIG_HOME`, `%APPDATA%`) ne sert qu'à l'import : `kioku mail --login` le copie au trousseau, puis propose de le supprimer dans le terminal (jamais sans un « oui »). Un fichier de jeton laissé par une version antérieure est importé au trousseau au prochain lancement ou `--login`, relu, puis supprimé (c'est un fichier que le core avait écrit) ; la sortie le dit.

Repli fichier (`secretStore: "file"`, ou aucun trousseau) : fichiers `0600` (temporaire puis renommage), dossier resserré en `0700` ; sous Windows, les modes POSIX sont sans effet. Avertissement à chaque lancement et dans `kioku doctor`. La garde ferme ce dossier à toute session (zone secrète).

Connexion : PKCE S256, boucle locale `127.0.0.1` (port choisi par le système), `state` vérifié (un mauvais `state` reçoit 400, on continue d'attendre), délai 5 minutes. Rafraîchissement automatique ; `invalid_grant` → message « relance `mail:login` ». Une entrée absente du trousseau → « relance `kioku mail --login <compte>` ».

**Non vérifié** : l'écriture par `security -i … -X` sur un vrai trousseau macOS (les tests simulent `security` ; je n'ai pas voulu écrire dans le trousseau de session pour un essai), et `secret-tool` sur une vraie session Linux.

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
| `secret-store.mjs` | trousseau du système (macOS, Linux), repli fichier 0600 |
| `providers/gmail.mjs` | fournisseur Gmail : `listThreads(label, since)`, `getThread(id)`, `getAttachment(msgId, attId)` |
| `fixtures.mjs` | faux Gmail des tests |

Un autre fournisseur (IMAP) implémente la même interface et se déclare dans `PROVIDERS` (`fetch-mail.mjs`) et `MAIL_PROVIDERS` (`hooks/config.mjs`) ; `mime.mjs` (`parseRaw`) lit déjà un message brut.

## Encodage des corps : ce que dit la doc, et ce qui est fait

Documentation officielle, ressource `MessagePartBody` (https://developers.google.com/gmail/api/reference/rest/v1/users.messages.attachments) :
`data` = « The body data of a MIME message part as a base64url encoded string. » Même champ pour `attachments.get`.

Le fournisseur décode ce base64url, et rien d'autre : on fait confiance à Gmail pour l'encodage de transfert de la
partie (revue I1). Un second décodage « au cas où » corromprait un texte déjà décodé (une URL `?id=12&page=2` dans une
partie `quoted-printable`) dans un bronze jamais réécrit. Si un texte d'une partie déclarée `quoted-printable` ressemble
fortement à du quoted-printable résiduel (`=C3=A9`, coupures douces), il est laissé tel quel, le bronze porte
`mail_warnings: ["qp-suspect"]` et le rapport le signale : à vérifier à la main. Tests : `gmail-payload.test.mjs`.

## Non vérifié contre l'API réelle

Les tests simulent l'API ; aucun appel réel n'a été fait. À confirmer au premier lancement réel : qu'aucun bronze ne
porte `qp-suspect` sur un mail `quoted-printable` ordinaire (sinon Gmail ne décode pas le transfert, et la décision I1
est à revoir), et que la requête `after:AAAA/MM/JJ` combinée à `labelIds` liste les fils ayant un message depuis cette
date.
