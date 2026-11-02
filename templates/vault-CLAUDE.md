# CLAUDE.md — mon coffre

> Part propre à ce coffre. Le schéma commun (médaillon, sessions, workflows, conventions, gate) est importé ci-dessous ; il est réécrit par `kioku` à chaque montée de version et ne se modifie pas ici. Les règles de chaque domaine sont dans `domains/<D>/rules.md`.

@.kioku/schema.md

---

## 1. Identité

- **Nom** : *(à compléter)*
- **Objet** : *(ce que ce coffre capitalise, pour qui)*
- **Domaines** : voir `kioku.config.json` ; périmètre et règles de chacun dans `domains/<D>/rules.md`.
- **Langue de contenu** : *(à compléter)*

## 2. Confidentialité propre au coffre

- **Remote** : *(aucun, ou le dépôt privé vérifié par `gh repo view <repo> --json isPrivate`, avec la date de vérification)*

## 3. Évolution du schéma de ce coffre

Chaque modification structurelle : une entrée `schema` dans `wiki/<D>/log.md`, et le « pourquoi » ci-dessous. Les règles qui en découlent vivent dans `domains/<D>/rules.md`.

*Révisions* :
