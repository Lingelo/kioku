#!/usr/bin/env node
// Assets PBR de la vidéo (scans CC0 de Poly Haven, https://polyhaven.com/license) : HDRI d'éclairage et
// textures diff / nor_gl / arm, projetées en triplanaire par pbr.js. Non versionnés (≈ 55 Mo, voir
// .gitignore) : à lancer une fois avant le rendu. Chaque fichier est vérifié par son md5 (épinglé par
// l'API Poly Haven), le rendu est donc reproductible et, une fois les assets là, hors ligne.
//
//   node fetch-assets.mjs           télécharge ce qui manque, vérifie tous les md5
//   node fetch-assets.mjs --check   vérifie seulement (code 1 si un fichier manque ou diffère)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DL = 'https://dl.polyhaven.org/file/ph-assets';
// [chemin local sous assets/, chemin source sous DL, md5]
export const ASSETS = [
  // lumière et reflets seulement : le fond reste du papier washi
  ['belfast_open_field_1k.hdr', 'HDRIs/hdr/1k/belfast_open_field_1k.hdr', '6a7f5cfebb9ab2a3e9e16b0883b9faab'],
  // gravier ratissé du karesansui (les sillons restent procéduraux, par-dessus)
  ['sandy_gravel/diff.jpg', 'Textures/jpg/1k/sandy_gravel/sandy_gravel_diff_1k.jpg', '9808ac7c155cff11314a4fe200255c50'],
  ['sandy_gravel/nor_gl.jpg', 'Textures/jpg/1k/sandy_gravel/sandy_gravel_nor_gl_1k.jpg', 'df94f818fdfab5afdaf11add554f51e7'],
  ['sandy_gravel/arm.jpg', 'Textures/jpg/1k/sandy_gravel/sandy_gravel_arm_1k.jpg', 'a1c3d1760e191c344b332310b7c5867b'],
  // pas japonais (tobi-ishi)
  ['rock_08/diff.jpg', 'Textures/jpg/1k/rock_08/rock_08_diff_1k.jpg', '2025c204133481612c74211135d7b371'],
  ['rock_08/nor_gl.jpg', 'Textures/jpg/1k/rock_08/rock_08_nor_gl_1k.jpg', '583a63d500f362e5ea9f795daf3d0c61'],
  ['rock_08/arm.jpg', 'Textures/jpg/1k/rock_08/rock_08_arm_1k.jpg', 'b638b4452c173dcd9e9cc59f70f40e56'],
  // mousse des rochers et des lanternes
  ['mossy_rock/diff.jpg', 'Textures/jpg/1k/mossy_rock/mossy_rock_diff_1k.jpg', 'a57fbbf55269eb64f8d40708fe3af26c'],
  ['mossy_rock/nor_gl.jpg', 'Textures/jpg/1k/mossy_rock/mossy_rock_nor_gl_1k.jpg', '59370f9b3d068271c2bccfb414dc325b'],
  ['mossy_rock/arm.jpg', 'Textures/jpg/1k/mossy_rock/mossy_rock_arm_1k.jpg', 'aa606bf7dda9c12bfea7702ea0507d7b'],
  // écorce du cerisier
  ['sakura_bark/diff.jpg', 'Textures/jpg/1k/sakura_bark/sakura_bark_diff_1k.jpg', '19741f188bdf496e4cb57e34c4211e95'],
  ['sakura_bark/nor_gl.jpg', 'Textures/jpg/1k/sakura_bark/sakura_bark_nor_gl_1k.jpg', 'c94e17644b3c6a5bf22f98ab960693c3'],
  ['sakura_bark/arm.jpg', 'Textures/jpg/1k/sakura_bark/sakura_bark_arm_1k.jpg', '523d671314f2f7b9c8682c3ecf328598'],
  // écorce du pin
  ['pine_bark/diff.jpg', 'Textures/jpg/2k/pine_bark/pine_bark_diff_2k.jpg', 'd10980446d36a65a73081cf61bc84992'],
  ['pine_bark/nor_gl.jpg', 'Textures/jpg/2k/pine_bark/pine_bark_nor_gl_2k.jpg', 'ee1de039967165665060653a0e12e571'],
  ['pine_bark/arm.jpg', 'Textures/jpg/2k/pine_bark/pine_bark_arm_2k.jpg', 'e8a438551d14ac7dccbaee5cc2c5fe45'],
  // toits de la pagode
  ['grey_roof_tiles_02/diff.jpg', 'Textures/jpg/2k/grey_roof_tiles_02/grey_roof_tiles_02_diff_2k.jpg', '2f49aaebd1b68926e76ddce57d27b6ff'],
  ['grey_roof_tiles_02/nor_gl.jpg', 'Textures/jpg/2k/grey_roof_tiles_02/grey_roof_tiles_02_nor_gl_2k.jpg', 'ec60f08e8819bfac34b71e04d354459b'],
  ['grey_roof_tiles_02/arm.jpg', 'Textures/jpg/2k/grey_roof_tiles_02/grey_roof_tiles_02_arm_2k.jpg', '3e3c52768bb79f9e4d00fc0af74e66e2'],
  // laque vermillon (torii, pagode)
  ['red_plaster_weathered/diff.jpg', 'Textures/jpg/2k/red_plaster_weathered/red_plaster_weathered_diff_2k.jpg', '1b0964d0aae71933d0e95a09252a1d43'],
  ['red_plaster_weathered/nor_gl.jpg', 'Textures/jpg/2k/red_plaster_weathered/red_plaster_weathered_nor_gl_2k.jpg', '0870564bdf8ae93abec92bdfe8a37b9e'],
  ['red_plaster_weathered/arm.jpg', 'Textures/jpg/2k/red_plaster_weathered/red_plaster_weathered_arm_2k.jpg', '1258f26a85cdce4b5d6554a880122ffd'],
  // bois laqué noir (kasagi, consoles)
  ['dark_wooden_planks/diff.jpg', 'Textures/jpg/2k/dark_wooden_planks/dark_wooden_planks_diff_2k.jpg', 'e6ae2fe585184c16343c56b833eddbf8'],
  ['dark_wooden_planks/nor_gl.jpg', 'Textures/jpg/2k/dark_wooden_planks/dark_wooden_planks_nor_gl_2k.jpg', 'c7b2e77045b0983cd7c9c408c0361a59'],
  ['dark_wooden_planks/arm.jpg', 'Textures/jpg/2k/dark_wooden_planks/dark_wooden_planks_arm_2k.jpg', '7e25bc0cd9f2cb69bdd47b81c6b31a97'],
  // granit : rochers, lanternes, socles
  ['rock_boulder_dry/diff.jpg', 'Textures/jpg/2k/rock_boulder_dry/rock_boulder_dry_diff_2k.jpg', 'fbc9cf377db427f54381f463c0639e1f'],
  ['rock_boulder_dry/nor_gl.jpg', 'Textures/jpg/2k/rock_boulder_dry/rock_boulder_dry_nor_gl_2k.jpg', '513ef3fdaadd106c38a9c40919918cc0'],
  ['rock_boulder_dry/arm.jpg', 'Textures/jpg/2k/rock_boulder_dry/rock_boulder_dry_arm_2k.jpg', 'acee3a43c7fc3bbe79c343cb3bb3b113'],
];

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const checkOnly = process.argv.includes('--check');

let bad = 0;
for (const [rel, src, sum] of ASSETS) {
  const f = path.join(dir, rel);
  // un fichier au mauvais md5 est traité comme absent : retéléchargé (ou signalé par --check), jamais gardé
  if (fs.existsSync(f) && md5(f) === sum) continue;
  if (checkOnly) { console.error(fs.existsSync(f) ? `✖ ${rel} : md5 ${md5(f)} ≠ ${sum}` : `✖ absent : ${rel}`); bad++; continue; }
  try {
    const r = await fetch(`${DL}/${src}`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.part`, Buffer.from(await r.arrayBuffer()));
    // vérifié AVANT de remplacer quoi que ce soit : un téléchargement corrompu ne devient jamais l'asset
    const got = md5(`${f}.part`);
    if (got !== sum) { fs.rmSync(`${f}.part`, { force: true }); throw new Error(`md5 ${got} ≠ ${sum}`); }
    fs.renameSync(`${f}.part`, f);
    console.error(`↓ ${rel}`);
  } catch (e) {
    fs.rmSync(`${f}.part`, { force: true });
    console.error(`✖ ${rel} : ${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}`); bad++;
  }
}
console.error(bad ? `✖ ${bad} problème(s)` : `✔ ${ASSETS.length} assets vérifiés`);
process.exit(bad ? 1 : 0);
