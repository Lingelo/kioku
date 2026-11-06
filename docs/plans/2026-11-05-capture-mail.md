# Plan : un second module de capture, le mail

Date : 2026-11-05. Statut : PR 1 sur `feat/connectors-socle` (en relecture), PR 2 sur `feat/capture-mail` (empilée sur la PR 1, en relecture).

## Objectif

Le core capte aujourd'hui une seule source : les notes d'un enregistreur Plaud. On ajoute le **mail**, Gmail d'abord :

- libellé **opt-in** (rien n'est lu hors du libellé choisi par l'utilisateur) ;
- le **fil** est l'unité de source ; les **PDF joints** sont des sources à part entière ;
- scope OAuth `gmail.readonly` seulement ; client OAuth **maison, sans dépendance** ;
- jeton **hors coffre**, dans `~/.config/kioku/mail/` (jamais versionné, jamais lu par une session).

Le mail réutilise le circuit de Plaud tel quel : dépôt dans `inbox/` → tri `claude -p` en mode triage (qui peut s'abstenir) → confirmation « oui » par domaine → une session ingest par source → rapport calculé sur les fichiers.

Deux PR, pour que la partie la plus sensible (le tri et la confirmation) ne soit écrite qu'une fois et relue à part.

```
 PR 1 : socle                                 PR 2 : module mail
 ┌──────────────────────────────┐             ┌──────────────────────────────────┐
 │ tools/connectors/            │◄────────────│ tools/mail-sync/                 │
 │   circuit, file, verrou,     │  branché    │   OAuth, fetch Gmail, dédup fil, │
 │   parcage, dédup, tri        │  comme      │   PDF, run.mjs                   │
 │ tools/plaud-sync/ = connect. │  Plaud      │ config, garde, init, scripts     │
 └──────────────────────────────┘             └──────────────────────────────────┘
```

## PR 1 — socle `tools/connectors/` et verrou commun

**Aucun changement de comportement pour Plaud.**

### Fichiers

| Fichier | Changement |
|---|---|
| `tools/connectors/circuit.mjs` | nouveau : la boucle de `plaud-sync/run.mjs` (tri, confirmation, ingestion avec relances et reprise, rapport, `--drop`, `--decide`, `--init-structure`), paramétrée par un connecteur |
| `tools/connectors/lock.mjs` | nouveau : verrou du coffre, chemin canonique + miroir de l'ancien fichier |
| `tools/connectors/pending.mjs` | déplacé depuis `plaud-sync/`, dossier d'état passé par `--state` |
| `tools/connectors/triage.mjs` | déplacé depuis `plaud-sync/org-proposals.mjs` |
| `tools/connectors/parked.mjs` | nouveau : `inbox/a-trancher/` et l'écart générique (extrait de `drop.mjs` et `run.mjs`) |
| `tools/connectors/dedup.mjs` | nouveau : primitives extraites de `plaud-sync/dedup.mjs` |
| `tools/plaud-sync/run.mjs` | réduit au connecteur Plaud (fetch, `--since`, `--skip`, écart par `seen.json`) ; reste le point d'entrée de `kioku plaud` |
| `tools/plaud-sync/{pending,lock,org-proposals,drop,dedup}.mjs` | shims ou enveloppes Plaud : mêmes exports, mêmes chemins |
| `hooks/vault.mjs`, `tools/kioku.mjs`, `tools/dashboard/local-state.mjs` | importent `tools/connectors/lock.mjs` |
| `tools/managed.mjs` | bloc géré du `.gitignore`, pour tout coffre : `tools/*/.lock.json`, `tools/*/.queue.json`, `tools/*/.snapshot.json` (verrou commun, son miroir, état de tout connecteur) ; `kioku upgrade --write` le pose dans un coffre existant |
| `hooks/guard.mjs` | `tools/connectors/` refusé en session `setup`, comme `plaud-sync/` |

`modules.plaud.state` reste `tools/plaud-sync` côté coffre : c'est l'état du coffre (`seen.json`, `exclusions.txt`, `.queue.json`), il ne bouge pas.

### Étapes

1. Verrou commun, avec ses tests (le risque principal, voir plus bas).
2. File, parcage, dédup : extraction derrière des shims, tests Plaud inchangés.
3. Circuit : transcription fidèle de `run.mjs`, points d'injection = fetch, drop, état, commandes citées.
4. Garde, `.gitignore` géré, docs courtes (README de `plaud-sync`, README du socle).

### Verrou : choix et transition

Le verrou était déjà partagé par `run.mjs`, `rotate-log`, `tag-org`, `tag-raw`, `upgrade --write` et `add-domain`, mais il vivait dans `tools/plaud-sync/.lock.json`, sous un nom de connecteur. Nouveau chemin canonique : `tools/connectors/.lock.json`. Pendant la transition, **prendre le verrou = prendre les deux fichiers**, canonique d'abord ; un échec sur le second rend le premier :

- un ancien `run.mjs` (plugin mis à jour en pleine ingestion) qui tient l'ancien fichier bloque un nouveau lanceur ;
- un nouveau lanceur qui tient les deux bloque un ancien processus, qui ne regarde que l'ancien fichier ;
- le tableau de bord, qui lit l'ancien fichier, reste juste.

Arrêt brutal entre les deux écritures : le canonique porte un PID mort, le miroir manque ; le lancement suivant reprend l'un et crée l'autre, rien ne bloque (testé avec un vrai processus tué par `SIGKILL`, entre les deux écritures et après).

**Condition de retrait du miroir** : il part dans la même version que les shims de `tools/plaud-sync/` (`lock.mjs`, `pending.mjs`, `org-proposals.mjs`), et pas avant que `tools/dashboard/local-state.mjs` et `watch.mjs` lisent le chemin canonique. Après cette version, plus aucun code du core ne connaît l'ancien chemin ; la note de version demande de ne pas mettre à jour en plein circuit.

Alternative à un seul fichier, proposée, non appliquée : ne prendre que le canonique, et seulement **lire** l'ancien (s'il est tenu par un processus vivant, refuser). Le dashboard lirait le canonique, puis l'ancien en repli. Gain : plus de second fichier, plus de `tools/plaud-sync/` créé dans un coffre sans Plaud. Perte : un ancien processus lancé *après* un nouveau lanceur ne le verrait pas. Ce cas suppose deux versions du core actives en même temps sur un coffre (checkout de développement et plugin installé), mais c'est justement la configuration de développement du core : le miroir reste le choix sûr pour la durée de la transition.

### Risques

- **Verrou** : une moitié de verrou laissée après un refus ou une erreur disque bloquerait tout le monde jusqu'à reprise. Couvert : refus et erreur rendent le canonique (tests).
- **Coffres existants non mis à jour** : tant que `upgrade --write` n'est pas passé, `tools/connectors/.lock.json` n'est pas ignoré ; il n'existe que pendant un lancement, mais un `git add -A` à ce moment-là le prendrait. Le motif `tools/*/` du bloc géré couvre aussi le miroir dans un coffre sans module Plaud (il ne l'était pas avant) et l'état du futur connecteur mail.
- **Régression silencieuse du circuit** : la boucle a été déplacée, pas réécrite ; les tests Plaud (`thread`, `drop`, `pending`) passent sans changer une assertion.
- **Message de refus du verrou** : il cite désormais `tools/connectors/.lock.json` au lieu de `tools/plaud-sync/.lock.json`.

### Ce qui n'est pas extrait

- `fetch-notes.mjs` : entièrement propre à Plaud (MCP, bloc anti-injection, amorçage `--seed`).
- Les règles de déduplication Plaud (`classify`, `legacyDomain` : id → nom → contenu) : le mail aura d'autres règles (fil + dernier message). Seules les primitives sont communes.
- Les messages « le circuit Plaud tourne » de `kioku.mjs` et `vault.mjs` : des tests existants les vérifient. À généraliser en PR 2, quand un second circuit peut réellement tenir le verrou (le verrou pourra alors porter le nom de son lanceur).

## PR 2 — le module mail

### Configuration

`modules.mail` dans `kioku.config.json` (nouvelle clé de `MODULES` dans `hooks/config.mjs`, validée comme `modules.plaud`) :

```json
"modules": {
  "mail": {
    "state": "tools/mail-sync",
    "accounts": [
      { "id": "travail", "provider": "gmail", "label": "kioku", "hint": { "domain": "pro", "org": "acme" } }
    ]
  }
}
```

- `id` : identifiant local du compte, sert au nom du jeton dans `~/.config/kioku/mail/<id>.json` ;
- `provider` : `gmail` seulement au départ ;
- `label` : le libellé opt-in ; rien d'autre n'est lu ;
- `hint` : **un indice pour le tri, jamais une décision**. Le tri juge sur le contenu et peut contredire l'indice ou s'abstenir.

### Dépôt et déduplication

- Bronze : `raw/<D>/emails/` (après tri), un fichier `.md` par fil, les PDF joints à côté, chacun source à part entière.
- Dédup par **id de fil + id du dernier message**. Une réponse tardive sur un fil déjà ingéré = **nouvelle source « suite »**, jamais une réécriture : le bronze est immuable.
- Registre `tools/mail-sync/seen.json` (ids seulement, sans objet ni contenu), écart par `--drop` via `connectors/parked.mjs`.

### Sécurité

- **Le corps d'un mail est une donnée non fiable** : n'importe qui peut écrire dans une boîte, donc tenter une injection de prompt. Le dépôt l'encapsule comme le fait le MCP Plaud (bloc à nonce), le prompt du tri et de l'ingestion le rappelle, et la garde reste le dernier mot (le tri n'écrit que dans `raw/<D>/` et `inbox/a-trancher/`).
- Jeton OAuth hors coffre, fichier en `0600`, jamais passé à une session `claude -p`.
- Scope `gmail.readonly` : aucune écriture possible dans la boîte.

### Garde

Patch de `hooks/guard.mjs`, sans relâcher de règle :

- `KIOKU_TOOLS` : ajouter `mail` (`kioku mail` refusé en setup comme `kioku plaud`) ;
- `NPM_SCRIPTS` : ajouter `mail` (scripts `mail:*`) ;
- `SETUP_DENIED` : ajouter `mail-sync[/\\]`.

### Outillage

- `kioku init --mail` (pose `modules.mail` sans compte, à compléter) ; `kioku mail …` relaie vers `tools/mail-sync/run.mjs --vault .`.
- Scripts gérés `mail:sync`, `mail:dry-run`, `mail:pending`, `mail:drop`, `mail:login` dans `managedScripts` ; état local `tools/mail-sync/.queue.json`, `.snapshot.json` déjà couvert par le motif `tools/*/` du bloc `.gitignore` géré.
- Guide « capture modules » (`docs/guide/`, en anglais) : Plaud et mail sur le même circuit.

### Risques

- Volume : un libellé mal choisi déverse des centaines de fils. Fait : libellés système refusés, `--max-threads` (100 fils déposés par compte et par lancement, les plus anciens d'abord), `--dry-run` en premier.
- Fils mixtes (pro et perso dans un même fil) : le tri doit parquer, pas trancher.
- Jeton absent, révoqué ou expiré : tous les jetons sont vérifiés (et rafraîchis) avant le premier dépôt ; un seul refusé arrête tout, sans dépôt. Une panne en cours de route (réseau, quota) peut laisser dans l'entrant les fils des comptes déjà captés : ils n'y sont triés que par le circuit mail (chaque circuit ne trie que ses propres sources, `tools/connectors/owners.mjs`).

### Écarts de la PR 2 par rapport à ce plan, et pourquoi

- **Le libellé choisit le fil, pas le message** (revue I5) : tout le fil est capté, y compris une réponse qui ne porte pas le libellé ; les brouillons, la corbeille et le spam ne le sont jamais.

- **Répertoire du module** : `tools/mail-sync/` (comme `plaud-sync/`), fournisseur dans `providers/gmail.mjs`, interface `listThreads(label, since)`, `getThread(id)`, `getAttachment(msgId, attId)`.
- **Libellé** : `label` facultatif, `kb` par défaut ; `max_pdf_mb` facultatif au niveau du module (défaut 20).
- **`message_ids:` en plus du frontmatter prévu** : la dédup s'appuie sur les messages couverts par chaque fichier, pas seulement sur le dernier. Un message supprimé dans Gmail ne fait pas re-déposer le fil, et un fil écarté par `--drop` garde ses messages couverts (une réponse ultérieure arrive en suite).
- **`body_sha256:`** : le nonce aléatoire du bloc non fiable rend chaque fichier unique ; l'empreinte du contenu est donc calculée sans lui et écrite en frontmatter.
- **PDF = fiche `.pdf.md` + PDF** : la file d'ingestion et la dédup ne connaissent que des `.md`. La fiche est la source que la file connaît ; le PDF est son « compagnon ». Le socle a gagné la notion de compagnon (parcage, écart, et un compagnon oublié dans l'entrant rejoint sa fiche après le tri) et une consigne de tri par connecteur (`triageNote`).
- **Corps du mail via `threads.get?format=full`** (un appel par fil, tailles et `attachmentId` connus avant téléchargement : un PDF trop gros n'est jamais téléchargé). `mime.mjs` sait aussi lire un message brut (`parseRaw`), pour le futur fournisseur IMAP. `body.data` est du base64url (doc `MessagePartBody`) ; la doc ne dit pas si l'encodage de transfert est retiré dessous. Décision (revue I1) : on ne décode que le base64url et on fait confiance à Gmail ; un texte qui ressemble à du quoted-printable résiduel est laissé tel quel, signalé au rapport et marqué `mail_warnings: [qp-suspect]` dans le bronze. Une heuristique de second décodage a été essayée puis retirée : elle corrompait les textes ASCII contenant `=XX` (URL à paramètres).
- **`hint.org` validé dans `config.mjs`** contre le registre du domaine, seulement si ce registre est lisible : un registre cassé ne doit pas rendre toute la configuration invalide (la garde la charge à chaque appel d'outil).
- **`--login` refusé dans toute session Claude Code** (pas seulement `setup`) : il ouvre un port local et attend le navigateur de l'utilisateur.
- **`kioku upgrade --write` n'ajoute pas `modules.mail` de lui-même** : comme Plaud, il complète un module déclaré (scripts), il ne déclare pas de module.

## Alternatives écartées

| Alternative | Pourquoi non |
|---|---|
| MCP Gmail communautaire | code tiers non épinglé, qui lit **toute** la boîte avec un scope large ; le core ne peut pas en garantir le comportement d'une version à l'autre |
| Apple Mail (AppleScript, base locale) | macOS seulement ; le core vise Windows, macOS et Linux |
| Copier `plaud-sync/` en `mail-sync/` | duplique la logique tri / confirmation / ingestion, la plus sensible : deux copies divergeraient, et un correctif sur l'une oublierait l'autre |
