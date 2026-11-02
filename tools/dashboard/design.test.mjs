/**
 * Tests du design washi : contraste WCAG calcule sur les tokens, habillage
 * sans ombre ni couleur litterale, et absence des contenus inventes par la maquette.
 * `node --test tools/dashboard/design.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { generateDashboardHtml } from './run.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'design-test-'));
  writeTestConfig(vault);
  put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
  put('wiki/perso/concepts/hds.md', '---\ntitle: HDS\ntype: concept\n---\nHDS.\n');
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

// Contenu du premier bloc <style> du HTML genere
const styleOf = (html) => {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, 'bloc <style> introuvable');
  return m[1];
};

// Declarations `--nom: valeur;` d'un bloc de selecteur donne (premier trouve)
const tokenBlock = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `bloc ${selector} introuvable`);
  const end = css.indexOf('}', start);
  const tokens = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
};

const parseColor = (value) => {
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), a: 1 };
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) return { rgb: [1, 2, 3].map((i) => Number(rgba[i])), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  return null;
};

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Resout un token en RGB opaque ; un rgba est compose sur la carte du theme
const resolver = (tokens) => (name) => {
  assert.ok(tokens[name] !== undefined, `token --${name} absent`);
  const c = parseColor(tokens[name]);
  assert.ok(c, `token --${name} non analysable : ${tokens[name]}`);
  if (c.a === 1) return c.rgb;
  const card = parseColor(tokens['bg-card']);
  return c.rgb.map((v, i) => v * c.a + card.rgb[i] * (1 - c.a));
};

const PIGMENTS = ['bronze', 'silver', 'gold', 'gate', 'success', 'warning', 'info', 'danger'];
const SURFACES = ['bg', 'bg-card', 'bg-recess'];

const checkTheme = (tokens, label) => {
  const color = resolver(tokens);
  const failures = [];
  const expect = (fg, bg, min) => {
    const r = ratio(color(fg), color(bg));
    if (r < min) failures.push(`${label} --${fg} sur --${bg} : ${r.toFixed(2)} < ${min}`);
  };
  for (const s of SURFACES) {
    expect('text', s, 4.5);
    expect('text-muted', s, 4.5);
    expect('accent-ink', s, 4.5);
    expect('focus-ring', s, 3);
    for (const p of PIGMENTS) {
      expect(`${p}-ink`, s, 4.5);
      expect(p, s, 3);
    }
  }
  for (const p of PIGMENTS) expect(`${p}-ink`, `${p}-bg`, 4.5);
  return failures;
};

describe('Design washi / sumi', () => {
  test('R1 : theme unique papier washi, sans bascule ni theme sombre', () => {
    const html = generateDashboardHtml(vault, 'pro');
    const root = tokenBlock(styleOf(html), ':root');
    assert.equal(root.bg, '#F4EFE6');
    assert.ok(!html.includes('data-theme'));
    assert.ok(!html.includes('toggleTheme'));
  });

  test('R5, KTD6, AE6 : contraste WCAG AA des tokens dans les deux domaines', () => {
    for (const domain of ['pro', 'perso']) {
      const tokens = tokenBlock(styleOf(generateDashboardHtml(vault, domain)), ':root');
      assert.deepEqual(checkTheme(tokens, domain), []);
    }
  });

  test('R11 : chaque pigment de dossier se detache du papier (>= 3:1)', () => {
    const tokens = tokenBlock(styleOf(generateDashboardHtml(vault, 'pro')), ':root');
    const color = resolver(tokens);
    const failures = ['people', 'projects', 'meetings', 'sources', 'concepts', 'decisions', 'organizations', 'syntheses']
      .map((f) => [f, ratio(color(`folder-${f}`), color('graph-bg'))])
      .filter(([, r]) => r < 3)
      .map(([f, r]) => `--folder-${f} : ${r.toFixed(2)}`);
    assert.deepEqual(failures, []);
  });

  // Distance OKLab (x100) : ~2 = juste perceptible ; sous ~7, deux petits noeuds se confondent
  const oklab = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const [l, m, s] = [
      0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
      0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
      0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
    ].map(Math.cbrt);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  };
  const deltaE = (a, b) => {
    const [x, y] = [oklab(a), oklab(b)];
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  };

  test('R12 : les pigments de dossier restent discernables entre eux, pleins (repos) et en lavis (retrait)', () => {
    const html = generateDashboardHtml(vault, 'pro');
    const tokens = tokenBlock(styleOf(html), ':root');
    const color = resolver(tokens);
    const wash = Number(html.match(/const WASH = ([\d.]+);/)[1]);
    const paper = color('graph-bg');
    const washed = (rgb) => rgb.map((v, i) => v + (paper[i] - v) * wash);
    const folders = ['people', 'projects', 'meetings', 'sources', 'concepts', 'decisions', 'organizations', 'syntheses'];
    const failures = [];
    for (let i = 0; i < folders.length; i++) {
      for (let j = i + 1; j < folders.length; j++) {
        const [a, b] = [color(`folder-${folders[i]}`), color(`folder-${folders[j]}`)];
        const full = deltaE(a, b);
        const rest = deltaE(washed(a), washed(b));
        // Pleins au repos : seuil haut ; en lavis (contexte d'une selection) : seuil de lisibilite
        if (full < 12) failures.push(`${folders[i]}/${folders[j]} pleins : ${full.toFixed(1)} < 12`);
        if (rest < 6) failures.push(`${folders[i]}/${folders[j]} en lavis : ${rest.toFixed(1)} < 6`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('R4 : l accent suit le domaine (indigo ai en pro, matcha en perso)', () => {
    const pro = tokenBlock(styleOf(generateDashboardHtml(vault, 'pro')), ':root');
    const perso = tokenBlock(styleOf(generateDashboardHtml(vault, 'perso')), ':root');
    assert.equal(pro.accent, '#2C4459');
    assert.equal(perso.accent, '#5B7C52');
  });

  test('R1 : ni degrade, ni verre depoli, ni ombre, ni couleur litterale hors des blocs de tokens', () => {
    const css = styleOf(generateDashboardHtml(vault, 'pro'));
    assert.ok(!css.includes('gradient'), 'gradient present');
    assert.ok(!css.includes('backdrop-filter'), 'backdrop-filter present');
    assert.ok(!/box-shadow:\s*(?!none)/.test(css), 'box-shadow present');
    // Retire le bloc de tokens, puis cherche hex et rgba restants
    const rules = css.slice(css.indexOf('}', css.indexOf(':root {')) + 1);
    const literals = rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
    assert.deepEqual(literals, []);
  });

  test('KTD4 : le JS du graphe lit ses couleurs dans les tokens, sans couleur en dur', () => {
    const html = generateDashboardHtml(vault, 'pro');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.ok(script.includes('readGraphPalette'));
    assert.deepEqual(script.match(/['"]#[0-9a-fA-F]{3,8}['"]/g) || [], []);
  });

  test('R10, AE5 : aucun contenu invente par la maquette Stitch', () => {
    const forbidden = [
      'sys.pilot', 'Densité', 'Clusters', 'Isolement', 'Gate de Maturité',
      "Ouvrir dans l'éditeur", 'Wabi-Sabi Workspace', 'v2.4', 'Esthétique Sumi',
      'Liaison réciproque', 'cdn.tailwindcss.com',
    ];
    for (const domain of ['pro', 'perso']) {
      const html = generateDashboardHtml(vault, domain);
      for (const s of forbidden) assert.ok(!html.includes(s), `${domain} contient « ${s} »`);
    }
  });
});
