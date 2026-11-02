#!/usr/bin/env node
/**
 * Injecte la timeline réelle de la voix off (voice/voice.json) dans kioku-explainer.html :
 * début de chaque phrase, fin de la vidéo et durée de rendu. À relancer après chaque
 * `voice.mjs` (changement de texte, de voix ou de pauses) : les slides, les animations et
 * les bruitages se recalent tous seuls.
 *
 *   node build-timeline.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const voice = JSON.parse(readFileSync(path.join(dir, 'voice', 'voice.json'), 'utf8'));
const htmlPath = path.join(dir, 'kioku-explainer.html');
let html = readFileSync(htmlPath, 'utf8');

const lines = Object.fromEntries(voice.lines.map((l) => [l.id, +l.start.toFixed(2)]));
const end = +(voice.lines.at(-1).end + 3.4).toFixed(2);   // derniere phrase + respiration finale

const swap = (re, value, label) => {
  if (!re.test(html)) throw new Error(`marqueur ${label} absent de kioku-explainer.html`);
  html = html.replace(re, value);
};
swap(/\/\*LINES\*\/[\s\S]*?\/\*END\*\//, `/*LINES*/${JSON.stringify(lines)}/*END*/`, 'LINES');
swap(/\/\*END_T\*\/[\d.]+\/\*END\*\//, `/*END_T*/${end}/*END*/`, 'END_T');
swap(/data-duration="\/\*DUR\*\/[\d.]+"|data-duration="[\d.]+"/, `data-duration="${end}"`, 'data-duration');

writeFileSync(htmlPath, html);
console.log(`timeline : ${voice.lines.length} phrases, durée ${end} s`);
