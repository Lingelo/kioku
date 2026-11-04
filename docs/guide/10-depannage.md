# 10. Dépannage

[← Sommaire](README.md)

Commencez toujours par :

```bash
kioku doctor --live
```

| Code | Sens | Quoi faire |
|---|---|---|
| `0` | cloisonnement prouvé | rien |
| `1` (`ECHEC`) | un prérequis ou un fichier manque | la sortie donne la commande |
| `3` (`CLOISONNEMENT`) | garde absente, désactivée, doublée ou qui laisse passer | **à corriger avant tout usage** : plugin installé et activé, pas de `disableAllHooks` |

## La garde

| Symptôme | Cause probable | Correction |
|---|---|---|
| tout est refusé dans un projet **hors coffre** | `VAULT_MODE` ou `VAULT_DOMAIN` exporté dans votre shell | `unset VAULT_MODE VAULT_DOMAIN`, et retirez l'export de votre profil |
| tout est refusé dans le coffre | configuration illisible : le coffre est traité comme abîmé | `kioku doctor` dit quoi |
| « commande refusée : recherche récursive sans dossier autorisé » | un `grep -r` ou une recherche sans chemin | donner un chemin précis du domaine (`wiki/<D>/…`) |
| « l'historique git contient le brut et tous les domaines » | `git show`, `git log -p`, `git diff`, `git grep`… | lire les fichiers du domaine, pas l'historique ; faire le diff vous-même, hors session |
| « commande refusée : elle nomme une zone fermée » | une commande cite `quarantine/`, `raw/`… (même dans un texte) | si c'est un faux positif : écrire la commande dans un script hors du coffre et le lancer |
| `git commit` refusé en session | voulu | commitez vous-même, dans votre terminal |
| une écriture sous `wiki/` refusée | voulu : l'or passe par la gate | candidate sous `.candidats/`, ou `kioku stage` pour une page existante |

**La garde ne se modifie depuis aucune session.** Si elle bloque à tort de façon répétée, c'est un défaut du core à signaler, pas à contourner.

## La gate

| Symptôme | Cause | Correction |
|---|---|---|
| `refusee … : …` | format, frontmatter, provenance | corriger ce que `check` nomme |
| `sans verdict` | la page a changé depuis la relecture, ou aucun relecteur n'a jugé | relancer le relecteur sur la version actuelle |
| `sans verdict … pour le domaine` | verdict rendu depuis une session d'un autre domaine | relancer le relecteur depuis une session du domaine de la page |
| `retenue … (code …)` | verdict `hold` | ne pas réécrire ; décider au lint (voir [6](06-lint-quarantaine.md)) |
| `en attente de decision` à `stage` ou `tag-org` | la page a une entrée en quarantaine | trancher d'abord au lint |
| `un pointeur de source ecartee ne se promeut pas` | `keep` ou `correct` sur un **pointeur** | un pointeur ne se décide que par `drop` |
| des candidates restent sous `.candidats/` | l'ingestion s'est arrêtée avant la gate | relancer `check` → relecteur → `promote` ; personne d'autre ne les voit |

## Le plugin et le relais

| Symptôme | Correction |
|---|---|
| « exige le format N » | plugin trop ancien : `claude plugin update kioku@<marketplace>` (les deux portées), redémarrer |
| `kioku: command not found` | relais absent du PATH : script d'installation du plugin (README) |
| le relais prend un clone au lieu du plugin | `KIOKU_HOME` est posé ; il le dit sur stderr. `unset KIOKU_HOME` |
| après une mise à jour, l'ancien comportement persiste | la session a été ouverte avant : redémarrer |
| une seule portée à jour | `claude plugin update` ne met à jour qu'une portée : relancer avec `--scope user` (ou l'inverse) |

## Plaud

| Symptôme | Correction |
|---|---|
| authentification refusée | `npx -y @plaud-ai/mcp@latest` pour refaire l'OAuth |
| « verrou pris » | un circuit tourne déjà sur cette machine : attendre. Un verrou dont le processus n'existe plus (circuit tué, machine redémarrée) est repris tout seul, rien à supprimer. Le verrou est local : deux postes ne se voient pas |
| code `2` à la fin | normal : des sources restent à reprendre (`plaud:pending`) ou à trancher (`inbox/a-trancher/`) |
| refus dans un worktree | lancer depuis le checkout principal, ou `--allow-worktree` |
