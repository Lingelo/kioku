# 5. Querying the wiki

[← Contents](README.md)

## Asking a question

```bash
npm run work
> what did we decide on the budget in March?
```

A plain question is enough; `/kioku:query <question>` forces the procedure. The session:

1. **checks that the question belongs to the session's domain.** If not, it answers in two lines (the domain it belongs to, the command to relaunch) without searching or saying anything of the other domain;
2. reads `wiki/<D>/index.md` (by search, not in full), then 2 to 5 pages and their links;
3. answers: **the answer first**, details in short blocks, uncertainties (⚠️), then one line `Sources : [[…]] · [[…]]`;
4. adds a 3-line entry to the log.

If the wiki isn't enough: **"pas trouvé dans le wiki, à investiguer"** (not found in the wiki, to investigate). That's a source to ingest, never a search in the raw files.

## Asking well

| Rather | Than |
|---|---|
| "what did we decide on X since January?" | "tell me everything about X" |
| "what feedback on Y's delivery, by date?" | "what is Y worth?" (no portrait) |
| "what did we ingest in February?" (reads the archive `log/2026-02.md`) | "what's in the log?" |
| a full name, or the project | a first name alone (ambiguous: the session lists the candidates) |

About a person, the answer gives role, organisation, projects, decisions and **attributed, dated feedback**, never a conclusion about the person. To prepare a one-to-one, ask for the feedback grouped by topic.

## A domain with the `org` extension

If the domain has the `org` extension (a registry of organisations), every page says **where the knowledge was acquired** (`org: [a, b]`). Name the organisation in the question to target it: the session filters on `org:` as the domain rules say.

## Filing a synthesis

An answer worth keeping (a comparison, a timeline, the state of a topic): `/kioku:save [slug]`. The session writes `syntheses/<slug>.md`, which only cites gold pages it has read, then sends it through the gate like everything else. A synthesis is precisely where a judgement can arise from assembling harmless facts: the reviewer watches for it.

## From the browser

The served dashboard (`npm run dashboard:serve:<D>`) has a question field: it starts the same `query` session, under the guard. See [7. Dashboard](07-dashboard.md).
