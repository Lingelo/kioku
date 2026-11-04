#!/usr/bin/env node
/**
 * Builds the guide's diagrams (docs/guide/media/diagrams/*.svg) from the declarations below.
 *
 *   node docs/guide/media/diagrams/build.mjs            writes every SVG next to this script
 *   node docs/guide/media/diagrams/build.mjs medallion  writes only the named diagrams
 *
 * Why a generator rather than hand-drawn SVG: a diagram is fixed by editing a declaration and re-running, without
 * recomputing coordinates by hand, and all diagrams share one palette (the one of the Kaizen docs, so the two plugins
 * of the marketplace read alike). Plain SVG, no script, no external font: it renders on GitHub, in an IDE, offline.
 *
 * Node only, no dependency.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── palette and primitives ──────────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
  .bg { fill: #fbfaf7; stroke: #e4e0d8; }
  text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; fill: #1f2328; }
  .title { font-size: 18px; font-weight: 700; }
  .desc { font-size: 12.5px; fill: #5c6370; }
  .label { font-size: 13.5px; font-weight: 600; }
  .sub { font-size: 11.5px; fill: #5c6370; }
  .small { font-size: 11px; fill: #5c6370; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .step { fill: #fdf1ea; stroke: #d97757; }
  .store { fill: #edf2fb; stroke: #5b7fbf; }
  .gate { fill: #fdeeee; stroke: #c94a4a; }
  .agent { fill: #ecf6ef; stroke: #3f8f5a; }
  .you { fill: #f3f0fa; stroke: #7a5fc0; }
  .state { fill: #fff8e1; stroke: #b8901c; }
  .plain { fill: #ffffff; stroke: #c9c4ba; }
  .closed { fill: #f2f2f2; stroke: #a0a0a0; stroke-dasharray: 4 3; }
  .region { fill: none; stroke: #b9b3a6; stroke-dasharray: 5 4; }
  .regionlabel { font-size: 11.5px; font-weight: 600; fill: #7d776b; letter-spacing: .04em; }
  .band { fill: #fff4dd; stroke: #d6a645; }
  .line { fill: none; stroke: #6e7681; stroke-width: 1.6; }
  .line.accent { stroke: #d97757; }
  .line.bad { stroke: #c94a4a; }
  .line.ok { stroke: #3f8f5a; }
  .line.blue { stroke: #5b7fbf; }
  .line.dashed { stroke-dasharray: 5 4; }
  .head { fill: #6e7681; } .head.accent { fill: #d97757; } .head.bad { fill: #c94a4a; } .head.ok { fill: #3f8f5a; } .head.blue { fill: #5b7fbf; }
  .tick { fill: #3f8f5a; font-weight: 700; } .cross { fill: #c94a4a; font-weight: 700; }
`;

const MARKERS = ['default', 'accent', 'bad', 'ok', 'blue']
  .map((k) => {
    const cls = k === 'default' ? 'head' : `head ${k}`;
    return `<marker id="h-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${cls}" d="M0,0 L10,5 L0,10 z"/></marker>`;
  })
  .join('');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A rounded box with a bold label and up to two sub-lines, centred. */
// A string wrapped in backticks renders in monospace, backticks stripped.
const isMono = (s) => /^`.*`$/.test(s);
const bare = (s) => (isMono(s) ? s.slice(1, -1) : s);

const box = (cls, x, y, w, h, label, ...subs) => {
  const lines = subs.filter(Boolean);
  const cx = x + w / 2;
  const total = 1 + lines.length;
  const first = y + h / 2 - ((total - 1) * 15) / 2 + 4.5;
  return [
    `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" stroke-width="1.5"/>`,
    `<text class="label${isMono(label) ? ' mono' : ''}" x="${cx}" y="${first}" text-anchor="middle">${esc(bare(label))}</text>`,
    ...lines.map((s, i) => `<text class="sub${isMono(s) ? ' mono' : ''}" x="${cx}" y="${first + 15 * (i + 1)}" text-anchor="middle">${esc(bare(s))}</text>`),
  ].join('\n');
};

/** A polyline arrow; kind = '', 'accent', 'bad', 'ok', 'blue'; dashed adds the dash. */
const arrow = (pts, kind = '', { dashed = false, both = false } = {}) => {
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const k = kind || 'default';
  return `<path class="line${kind ? ` ${kind}` : ''}${dashed ? ' dashed' : ''}" d="${d}" marker-end="url(#h-${k})"${both ? ` marker-start="url(#h-${k})"` : ''}/>`;
};

/**
 * A line of text. Inline `code` spans render in monospace (tspans), the rest in the class font.
 */
const text = (x, y, s, cls = 'small', anchor = 'start') => {
  const parts = String(s).split(/(`[^`]+`)/).filter(Boolean);
  const inner = parts.map((p) => (isMono(p) ? `<tspan class="mono">${esc(bare(p))}</tspan>` : esc(p))).join('');
  return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${inner}</text>`;
};

const region = (x, y, w, h, label) =>
  `<rect class="region" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` + (label ? `\n<text class="regionlabel" x="${x + 12}" y="${y + 18}">${esc(label)}</text>` : '');

const band = (x, y, w, h, s) =>
  `<rect class="band" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" stroke-width="1.5"/>\n<text class="label" x="${x + w / 2}" y="${y + h / 2 + 4.5}" text-anchor="middle" style="font-size:13px">${esc(s)}</text>`;

/** The legend row at the bottom: [[cls, label], …]. */
const legend = (x, y, items) =>
  items
    .map(([cls, label], i) => {
      const lx = x + i * 150;
      return `<rect class="${cls}" x="${lx}" y="${y - 10}" width="14" height="14" rx="3" stroke-width="1.5"/>${text(lx + 20, y + 1.5, label)}`;
    })
    .join('\n');

const svg = (w, h, title, desc, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>${STYLE}</style>
<defs>${MARKERS}</defs>
<rect class="bg" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14"/>
<text class="title" x="28" y="38">${esc(title)}</text>
<text class="desc" x="28" y="58">${esc(desc)}</text>
${body.flat().join('\n')}
</svg>
`;

// ── diagrams ────────────────────────────────────────────────────────────────────────────────────────────────────────

const D = {};

D.medallion = () =>
  svg(1100, 520, 'The medallion', 'A source climbs three tiers. Each tier is written by one step, and only the top one is ever queried.', [
    box('plain', 36, 120, 150, 80, 'inbox/', 'unsorted', 'never versioned'),
    box('store', 252, 120, 170, 80, 'raw/<D>/  bronze', 'as it came in', 'immutable'),
    box('store', 488, 120, 170, 80, 'silver/<D>/  silver', 'one sheet per source', 'cleaned, flags set'),
    box('store', 724, 120, 170, 80, 'wiki/<D>/  gold', 'the wiki pages', 'index · log · overview'),
    box('agent', 950, 128, 116, 64, 'queries', 'read gold only'),
    arrow([[186, 160], [252, 160]], 'accent'),
    text(219, 150, 'triage', 'small', 'middle'),
    arrow([[422, 160], [488, 160]], 'accent'),
    text(455, 150, 'ingest', 'small', 'middle'),
    arrow([[658, 160], [724, 160]], 'accent'),
    text(691, 150, 'gate', 'small', 'middle'),
    arrow([[894, 160], [950, 160]], 'blue'),
    box('gate', 600, 268, 200, 64, 'quarantine/<D>/', 'held, flagged, pointers'),
    arrow([[691, 200], [691, 236], [700, 236], [700, 268]], 'bad', { dashed: true }),
    text(708, 250, 'held by the reviewer', 'small'),
    box('you', 860, 268, 170, 64, 'you decide', 'keep · correct · drop'),
    arrow([[800, 300], [860, 300]], '', {}),
    region(36, 370, 1030, 84, 'WHO READS EACH TIER'),
    text(56, 414, 'inbox/ → triage session only'),
    text(276, 414, 'raw/, silver/ → ingest session only'),
    text(546, 414, 'wiki/ → query and ingest sessions'),
    text(806, 414, 'quarantine/ → no session (you, in an editor)'),
    text(56, 436, 'Each tier also exists once per domain <D>: a page never crosses domains.', 'sub'),
    legend(36, 492, [['plain', 'unsorted'], ['store', 'tier (folder)'], ['gate', 'held'], ['agent', 'reader'], ['you', 'you']]),
  ]);

D.sessions = () =>
  svg(1100, 600, 'Sessions: one mode, one domain', 'The launcher sets VAULT_MODE and VAULT_DOMAIN; the guard reads them on every tool call and refuses what lies outside.', [
    box('you', 36, 96, 190, 60, 'npm run work', '`kioku session work`'),
    box('step', 296, 96, 230, 60, 'launcher (tools/vault.mjs)', 'sets VAULT_MODE, VAULT_DOMAIN'),
    box('agent', 596, 96, 200, 60, 'claude', 'starts on the mode’s task'),
    box('gate', 866, 96, 200, 60, 'guard (PreToolUse hook)', 'every Read, Write, Bash'),
    arrow([[226, 126], [296, 126]], 'accent'),
    arrow([[526, 126], [596, 126]], 'accent'),
    arrow([[796, 126], [866, 126]], 'bad'),
    text(831, 116, 'each call', 'small', 'middle'),
    text(36, 200, 'WHAT EACH MODE SEES', 'regionlabel'),
    ...[
      ['query', 'npm run <D> · lint:<D>', 'wiki/<D>/', '.candidats/, index.md, log.md'],
      ['ingest', 'npm run ingest:<D>', 'raw/<D>/ silver/<D>/ wiki/<D>/', 'silver/, .candidats/, index, log, overview'],
      ['triage', 'npm run triage', 'inbox/', 'mv to raw/<D>/'],
      ['setup', 'npm run setup', 'config, domains/', 'nothing directly: kioku init / add-domain / upgrade'],
    ].flatMap(([mode, cmd, reads, writes], i) => {
      const y = 214 + i * 64;
      return [
        box('step', 36, y, 140, 50, mode),
        text(196, y + 22, `\`${cmd}\``),
        text(196, y + 40, 'starts on its task', 'sub'),
        box('store', 430, y, 280, 50, 'reads', reads),
        box('plain', 730, y, 336, 50, 'writes', writes),
      ];
    }),
    band(36, 486, 1030, 40, 'In no mode: another domain · quarantine/ · .verdicts/ · the config · git history (it holds every domain)'),
    text(36, 560, 'To change domain: /exit, then npm run <other>. Never export VAULT_MODE or VAULT_DOMAIN in your shell: the guard would then refuse everything in your other projects.', 'sub'),
  ]);

D.ingest = () =>
  svg(1100, 640, 'Ingesting a source', 'Two ways in, three tiers, then the gate. An ingestion is only finished when the pages are in gold (or in quarantine) and the index and log are updated.', [
    box('you', 36, 96, 220, 60, 'drop in inbox/', 'domain unknown, or many'),
    box('you', 36, 196, 220, 60, 'drop in raw/<D>/<type>/', 'you know the domain'),
    box('step', 316, 96, 200, 60, 'npm run triage', 'one declared domain, or abstain'),
    arrow([[256, 126], [316, 126]], 'accent'),
    box('plain', 576, 96, 190, 60, 'stays in inbox/', 'question asked, reason written'),
    arrow([[516, 126], [576, 126]], '', { dashed: true }),
    text(546, 116, 'doubt', 'small', 'middle'),
    box('step', 316, 290, 200, 60, 'npm run ingest:<D>', 'lists what is not in gold, asks'),
    arrow([[416, 156], [416, 290]], 'accent'),
    text(424, 226, 'moved to raw/<D>/'),
    arrow([[146, 256], [146, 320], [316, 320]], 'accent'),
    region(560, 200, 506, 330, 'PER SOURCE, IN DATE ORDER'),
    box('store', 590, 236, 210, 56, '1 · bronze → silver', 'silver/<D>/<slug>.md'),
    box('gate', 840, 236, 196, 56, 'pointer in quarantine', 'insult, portrait, sensitive'),
    arrow([[800, 264], [840, 264]], 'bad', { dashed: true }),
    box('store', 590, 320, 210, 56, '2 · silver → candidates', '.candidats/wiki/<D>/…'),
    text(820, 340, 'source, meeting, decisions,'),
    text(820, 356, 'people and concepts touched'),
    box('gate', 590, 404, 210, 56, '3 · gate', 'check → reviewer → promote'),
    box('store', 840, 404, 196, 56, 'wiki/<D>/', 'index + log updated'),
    arrow([[695, 292], [695, 320]], 'accent'),
    arrow([[695, 376], [695, 404]], 'accent'),
    arrow([[800, 432], [840, 432]], 'ok'),
    arrow([[516, 320], [560, 320], [560, 264], [590, 264]], 'accent'),
    region(36, 400, 490, 130, 'WHEN AN ENTITY PAGE IS CREATED'),
    text(56, 444, 'person · concept: central to the source, or named in ≥ 2 sources'),
    text(56, 466, 'identity given by the source, never guessed from a first name'),
    text(56, 488, 'otherwise: a link to a missing page, a wanted gap'),
    text(56, 510, 'existing page: `kioku stage <D> <folder/slug>`, then edit the copy', 'small'),
    text(36, 590, 'Several sources at once are taken one by one, but kept in mind: the afternoon meeting may confirm or contradict the morning one, and the page says so.', 'sub'),
    text(36, 610, 'A file name is read by every link that cites it: never a candidate’s name, an assessed person or sensitive data in a slug.', 'sub'),
  ]);

D.gate = () =>
  svg(1100, 600, 'The gate', 'The writer never judges its own page. A distinct reviewer gives a verdict bound to the page’s exact sha256 and to its domain.', [
    box('step', 36, 110, 230, 64, 'candidate', '.candidats/wiki/<D>/…', '<folder>/<slug>.md'),
    box('gate', 326, 110, 200, 64, '`kioku check`', 'deterministic, no model'),
    box('agent', 596, 110, 200, 64, 'reviewer agent', 'reads the page alone'),
    box('gate', 866, 110, 200, 64, '`kioku promote`', 'writes the gate: line'),
    arrow([[266, 142], [326, 142]], 'accent'),
    arrow([[526, 142], [596, 142]], 'accent'),
    text(561, 132, 'conform', 'small', 'middle'),
    arrow([[796, 142], [866, 142]], 'accent'),
    text(831, 132, 'verdict', 'small', 'middle'),
    text(326, 196, 'format, frontmatter, provenance'),
    text(326, 212, '(raw:, silver sheet), no Markdown'),
    text(326, 228, 'link, no secret, no cross-domain link'),
    text(596, 196, 'common base + domains/<D>/rules.md'),
    text(596, 212, '`ok` | `hold <code>`'),
    text(596, 228, 'bound to sha256 + domain'),
    box('plain', 36, 280, 230, 56, 'refused', 'fix what check names'),
    arrow([[340, 174], [340, 250], [151, 250], [151, 280]], 'bad', { dashed: true }),
    box('store', 866, 280, 200, 56, 'admitted · wiki/<D>/', 'gate: passe … juge=relecteur'),
    box('gate', 596, 280, 200, 56, 'held · quarantine/<D>/', 'you decide at the lint'),
    box('plain', 326, 280, 200, 56, 'no verdict', 'nothing enters'),
    arrow([[966, 174], [966, 280]], 'ok'),
    text(974, 236, 'ok'),
    arrow([[926, 174], [926, 252], [696, 252], [696, 280]], 'bad'),
    text(800, 246, 'hold', 'small', 'middle'),
    arrow([[886, 174], [886, 262], [426, 262], [426, 280]], '', { dashed: true }),
    text(326, 356, 'page changed after review,'),
    text(326, 372, 'or verdict from another domain'),
    region(36, 410, 500, 160, 'HOLD CODES'),
    text(56, 452, '`insulte`  insult'),
    text(56, 474, '`jugement-personne`  trait, portrait, unattributed feedback'),
    text(56, 496, '`diffamation`  accusation presented as fact'),
    text(56, 518, '`domaine`  content of another domain'),
    text(56, 540, '`sensible`  what the domain rules call sensitive'),
    region(566, 410, 500, 160, 'THE LINE'),
    text(586, 452, 'passes', 'label'),
    text(586, 472, 'a dated fact · a stated expectation · work feedback that is'),
    text(586, 488, 'attributed, dated, about a situation, not assembled'),
    text(586, 516, 'held', 'label'),
    text(586, 536, 'a trait · a portrait (also built from harmless facts)'),
    text(586, 552, 'an accusation as fact · in doubt, held: you decide'),
  ]);

D.quarantine = () =>
  svg(1100, 560, 'Quarantine: three natures, three meanings', 'kioku undecided shows the nature of each item. Read it before choosing: drop does not mean the same thing for all three.', [
    text(36, 98, 'WHERE IT COMES FROM', 'regionlabel'),
    text(256, 98, 'NATURE', 'regionlabel'),
    text(566, 98, 'keep', 'label', 'middle'),
    text(746, 98, 'correct', 'label', 'middle'),
    text(946, 98, 'drop', 'label', 'middle'),
    ...[
      [110, ['step', '`kioku promote`', 'verdict hold'], ['gate', 'held', 'a candidate NOT in gold'],
        [['plain', 'enters gold', 'juge=utilisateur'], ['plain', 'back to .candidats/', 'rewrite, then the gate'], ['gate', 'DELETED', 'the candidate is gone']]],
      [204, ['step', '`kioku flag`', 'at the lint'], ['state', 'flagged', 'a page already in gold'],
        [['plain', 'flag lifted', 'page unchanged'], ['plain', 'copied to .candidats/', 'fix, then the gate'], ['gate', 'LEAVES the wiki', 'copy in quarantine/<D>/sortis/']]],
      [298, ['step', '`kioku quarantine`', 'at ingest'], ['plain', 'pointer', 'NO page: a passage set aside'],
        [['closed', 'refused'], ['closed', 'refused'], ['plain', 'closed', 'no page is touched']]],
    ].flatMap(([y, from, nature, cells]) => [
      box(from[0], 36, y, 180, 60, from[1], from[2]),
      arrow([[216, y + 30], [256, y + 30]], from[1].includes('promote') ? 'bad' : ''),
      box(nature[0], 256, y, 210, 60, nature[1], nature[2]),
      ...cells.map(([cls, a, b], i) => box(cls, 486 + i * 190, y, 170 + (i === 2 ? 30 : 0), 60, a, b)),
    ]),
    band(36, 392, 1030, 40, 'kioku decide <D> <name> keep|correct|drop [note]   ·   only after your explicit decision'),
    text(36, 480, 'Every decision is logged in quarantine/<D>/decisions.jsonl. A decision that covers a family of cases becomes a rule in domains/<D>/rules.md (Relecture).', 'sub'),
    text(36, 500, 'No session reads quarantine/: open the .md in your editor to judge on the text. After dropping a flagged page, run kioku audit <D> for incoming links.', 'sub'),
    legend(36, 536, [['gate', 'destructive'], ['closed', 'refused'], ['state', 'in gold, flagged'], ['plain', 'neutral']]),
  ]);

D.plaud = () =>
  svg(1100, 520, 'Plaud: from the recorder to gold', 'One command, launched by you, never scheduled. Each step is a guarded session; the confirmation is the last cheap moment to fix a domain mistake.', [
    box('plain', 36, 110, 150, 64, 'Plaud', 'meeting notes'),
    box('store', 226, 110, 150, 64, 'inbox/', 'last 7 days'),
    box('step', 416, 110, 150, 64, 'triage', 'session'),
    box('you', 606, 110, 170, 64, 'confirmation', 'what enters, per domain'),
    box('step', 816, 110, 150, 64, 'ingest', 'one session per source'),
    box('store', 1000 - 14, 110, 80, 64, 'gold'),
    arrow([[186, 142], [226, 142]], 'accent'),
    arrow([[376, 142], [416, 142]], 'accent'),
    arrow([[566, 142], [606, 142]], 'accent'),
    arrow([[776, 142], [816, 142]], 'accent'),
    text(796, 132, 'yes', 'small', 'middle'),
    arrow([[966, 142], [986, 142]], 'ok'),
    box('plain', 416, 230, 150, 64, 'inbox/a-trancher/', 'reason written'),
    arrow([[491, 174], [491, 230]], '', { dashed: true }),
    text(499, 206, 'abstains'),
    box('plain', 606, 230, 170, 64, 'nothing ingested', 'Enter = no'),
    arrow([[691, 174], [691, 230]], '', { dashed: true }),
    box('gate', 816, 230, 150, 64, 'quarantine', 'gate holds'),
    arrow([[891, 174], [891, 230]], 'bad', { dashed: true }),
    text(36, 340, 'COMMANDS', 'regionlabel'),
    ...[
      ['`npm run plaud:sync`', 'full circuit, last 7 days  (add -- --since 2026-03-01, or -- --group-by-day)'],
      ['`npm run plaud:dry-run`', 'what would be dropped in the inbox; no session'],
      ['`npm run plaud:pending`', 'triage + ingest what is already in the inbox or the queue'],
      ['`kioku plaud --skip-fetch --decide <file>=<D>`', 'route a parked source to a domain'],
      ['`npm run plaud:drop -- <file>`', 'drop a parked source for good'],
    ].flatMap(([cmd, what], i) => [text(36, 362 + i * 19, cmd), text(400, 362 + i * 19, what)]),
    text(36, 476, 'Once per machine: npx -y @plaud-ai/mcp@latest (OAuth; the token stays in ~/.plaud/). Exclude a recording: its of_… id in tools/plaud-sync/exclusions.txt.', 'sub'),
    text(36, 496, 'Exit code 0 everything is in; 2 something is left to resume or to decide; 1 error.', 'sub'),
  ]);

D.update = () =>
  svg(1100, 470, 'Updating Kioku', 'The vault carries no plugin version, only a format number. A plugin update touches one scope at a time, and a running session keeps the old guard.', [
    box('you', 36, 110, 230, 64, 'claude plugin update', 'kioku@<marketplace>'),
    box('store', 326, 92, 200, 48, 'project scope', 'in a vault'),
    box('store', 326, 150, 200, 48, 'user scope', '--scope user'),
    arrow([[266, 132], [326, 116]], 'accent'),
    arrow([[266, 150], [326, 174]], 'accent', { dashed: true }),
    text(276, 196, 'run both', 'small'),
    box('step', 586, 110, 200, 64, 'restart sessions', 'the guard loads at start'),
    arrow([[526, 116], [556, 116], [556, 142], [586, 142]], 'accent'),
    arrow([[526, 174], [556, 174], [556, 142]], 'accent'),
    box('gate', 846, 110, 220, 64, '`kioku doctor --live`', 'a real session must be refused'),
    arrow([[786, 142], [846, 142]], 'accent'),
    region(36, 236, 500, 190, 'KIOKU UPGRADE: BACK TO WHAT INIT PRODUCES'),
    text(56, 276, '`kioku upgrade`            simulation, shows the diff'),
    text(56, 296, '`kioku upgrade --write`    applies it (idempotent)'),
    text(56, 326, 'rewrites: package.json scripts starting with "kioku ",'),
    text(56, 342, 'the # >>> kioku .gitignore block, the plugin activation,'),
    text(56, 358, 'config additions only, .kioku/schema.md'),
    text(56, 392, 'never touched: wiki/ · raw/ · silver/ · CLAUDE.md · domain rules · registry', 'small'),
    region(566, 236, 500, 190, 'FORMAT'),
    text(586, 276, 'plugin older than the vault’s format → refuses to start,'),
    text(586, 292, 'prints the update command'),
    text(586, 322, 'plugin newer → reads older vaults;'),
    text(586, 338, 'kioku upgrade brings them to the current shape'),
    text(586, 368, 'new machine: install the plugin, git clone the vault,'),
    text(586, 384, 'open it once in claude, then kioku doctor --live'),
    text(586, 404, 'the inbox never travels: triage it before leaving', 'sub'),
  ]);

D.day = () =>
  svg(1100, 400, 'A working day', 'Capture in the morning, ask during the day, review at the end of the week. Each line is a separate session on one domain.', [
    ...[
      ['morning', 'capture', [['npm run plaud:sync', 'meetings → gold'], ['npm run triage', 'files from inbox/'], ['npm run ingest:<D>', 'what is left']]],
      ['day', 'ask', [['npm run <D>', '"what did we decide on X?"'], ['/kioku:save', 'keep a durable answer'], ['dashboard:serve:<D>', 'ask from the browser']]],
      ['week', 'review', [['npm run lint:<D>', 'audit, legacy pages, quarantine'], ['kioku undecided', 'nature, code, actions'], ['kioku rotate-log <D>', 'archive past months']]],
    ].flatMap(([when, what, steps], r) => {
      const y = 96 + r * 96;
      return [
        box('you', 36, y, 150, 68, when, what),
        ...steps.map(([cmd, sub], i) => box(i === 0 ? 'step' : 'plain', 236 + i * 280, y + 6, 250, 56, cmd, sub)),
        arrow([[186, y + 34], [236, y + 34]], 'accent'),
      ];
    }),
  ]);

// ── write ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(D);
for (const n of names) {
  if (!D[n]) {
    console.error(`unknown diagram: ${n} (known: ${Object.keys(D).join(', ')})`);
    process.exit(1);
  }
  const file = path.join(HERE, `${n}.svg`);
  writeFileSync(file, D[n]());
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
