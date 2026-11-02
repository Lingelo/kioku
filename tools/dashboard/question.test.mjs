/**
 * tools/dashboard/question.test.mjs
 *
 * Rendu de l'onglet 問 Question et garde-fous de DA et de silo (plan 2026-10-02-2218, U3 et U4).
 * Le comportement interactif (flux, interruption) se verifie a la main sous `npm run dashboard:dev`.
 * `node --test tools/dashboard/question.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { generateDashboardHtml } from './run.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Regles CSS de l'onglet (blocs dont le selecteur commence par #tab-question ou .question-). */
const questionCss = (html) => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  return css.match(/(#tab-question|\.question-)[^{]*\{[^}]*\}/g) || [];
};

/** Bloc HTML de l'onglet. */
const questionHtml = (html) => html.slice(html.indexOf('<main id="tab-question"'), html.indexOf('</main>', html.indexOf('<main id="tab-question"')));

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'question-test-'));
  writeTestConfig(vault);
  put('wiki/pro/projects/atlas.md', '---\ntitle: Atlas\ntype: project\n---\nAtlas.\n');
  put('wiki/perso/projects/maison.md', '---\ntitle: Maison\ntype: project\n---\nMaison.\n');
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U3 : onglet 問 Question', () => {
  test('bouton 問 toujours avec le libelle Question, route question, panneau present', () => {
    const html = generateDashboardHtml(vault, 'pro');
    assert.match(html, /id="btn-question"[^>]*>.*?問.*?<span>Question<\/span>/s);
    assert.ok(html.includes("question: 'question'"));
    assert.ok(html.includes('<main id="tab-question"'));
  });

  test('rendu live : jeton dans les donnees ; rendu statique : jeton null et panneau d explication', () => {
    const live = generateDashboardHtml(vault, 'pro', { mode: 'live', askToken: 'a'.repeat(48) });
    assert.ok(live.includes(`"askToken":"${'a'.repeat(48)}"`));
    const fileHtml = generateDashboardHtml(vault, 'pro');
    assert.ok(fileHtml.includes('"askToken":null'));
    // un jeton passe hors mode live est ignore
    assert.ok(generateDashboardHtml(vault, 'pro', { askToken: 'b'.repeat(48) }).includes('"askToken":null'));
  });

  test('couvre AE5 : en statique, la commande de lancement est affichee et aucun fetch n est lance hors live', () => {
    const html = generateDashboardHtml(vault, 'pro');
    assert.ok(questionHtml(html).includes('npm run dashboard:serve:pro'));
    // le seul fetch de la page est garde par la detection du mode live
    const script = html.slice(html.lastIndexOf('<script>'));
    const init = script.slice(script.indexOf('function initQuestion'), script.indexOf('// Routes dans le hash'));
    assert.ok(init.indexOf("window.location.protocol !== 'file:'") < init.indexOf("fetch('/ask'"));
    assert.ok(init.includes('if (!isLive) return;'));
  });

  test('etat vide, libelle du champ, annonce polie et domaine affiche suivent le domaine', () => {
    for (const domain of ['pro', 'perso']) {
      const block = questionHtml(generateDashboardHtml(vault, domain));
      assert.ok(block.includes(`Interroger l'or · domaine ${domain}`));
      assert.ok(block.includes(`Pose une question au wiki ${domain}.`));
      assert.ok(block.includes('class="question-example"'));
      assert.match(block, /<label for="question-input"[^>]*>Question au wiki/);
      assert.ok(block.includes('aria-live="polite"'));
      assert.ok(block.includes(`session : query / ${domain}`));
    }
  });
});

describe('U4 : garde-fous de DA et de silo pour l onglet', () => {
  test('aucune couleur litterale, ombre ou degrade dans les regles de l onglet', () => {
    const rules = questionCss(generateDashboardHtml(vault, 'pro'));
    assert.ok(rules.length > 10, 'regles de l onglet trouvees');
    for (const rule of rules) {
      assert.deepEqual(rule.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|gradient|box-shadow|backdrop-filter/g) || [], [], rule);
    }
  });

  test('vermillon reserve a la gate et aux alertes de la gate : l onglet n utilise ni --gate ni --danger', () => {
    const rules = questionCss(generateDashboardHtml(vault, 'pro')).join('\n');
    assert.ok(!/var\(--(gate|danger)/.test(rules));
  });

  test('silo : l onglet pro ne mentionne pas perso, et inversement', () => {
    const pro = questionHtml(generateDashboardHtml(vault, 'pro'));
    const perso = questionHtml(generateDashboardHtml(vault, 'perso'));
    assert.ok(!/perso/.test(pro));
    assert.ok(!/\bpro\b/.test(perso));
  });
});
