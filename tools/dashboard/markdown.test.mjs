/**
 * Tests du rendu Markdown sur mesure : U5
 * `node --test tools/dashboard/markdown.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { renderMarkdown, escapeHtml } from './markdown.mjs';

describe('U5 : Rendu Markdown sur mesure', () => {
  test('echappement HTML : securise contre XSS et conserve les chevrons metier', () => {
    const md = 'Consulter <date> et <script>alert(1)</script> ainsi que "guillemets" & \'esperluette\'.';
    const html = renderMarkdown(md);

    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;date&gt;'));
    assert.ok(html.includes('&amp;'));
    assert.ok(html.includes('&quot;guillemets&quot;'));
  });

  test('titres : niveaux 1 a 6', () => {
    const md = '# Titre 1\n## Titre 2\n### Titre 3\n#### Titre 4';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<h1>Titre 1</h1>'));
    assert.ok(html.includes('<h2>Titre 2</h2>'));
    assert.ok(html.includes('<h3>Titre 3</h3>'));
    assert.ok(html.includes('<h4>Titre 4</h4>'));
  });

  test('blocs de code et code inline', () => {
    const md = 'Voici `code_inline()` et un bloc :\n```javascript\nconst a = <tag>;\n```';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<code>code_inline()</code>'));
    assert.ok(html.includes('<pre><code class="language-javascript">const a = &lt;tag&gt;;\n</code></pre>'));
  });

  test('tableaux Markdown', () => {
    const md = '| Entete A | Entete B |\n| --- | --- |\n| Cellule 1 | Cellule 2 |\n| Cellule 3 | Cellule 4 |';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<table>'));
    assert.ok(html.includes('<thead>'));
    assert.ok(html.includes('<th>Entete A</th>'));
    assert.ok(html.includes('<tbody>'));
    assert.ok(html.includes('<td>Cellule 1</td>'));
  });

  test('callouts Obsidian', () => {
    const md = '> [!warning] Titre Attention\n> Ligne 1 du callout\n> Ligne 2';
    const html = renderMarkdown(md);

    assert.ok(html.includes('class="callout callout-warning"'));
    assert.ok(html.includes('callout-title'));
    assert.ok(html.includes('Titre Attention'));
    assert.ok(html.includes('Ligne 1 du callout'));
  });

  test('citations standard', () => {
    const md = '> Citation de Speaker 1 datée du jour.';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<blockquote>'));
    assert.ok(html.includes('Citation de Speaker 1'));
  });

  test('listes a puces et numerotees', () => {
    const md = '- Item A\n- Item B\n\n1. Premier\n2. Deuxieme';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<ul>'));
    assert.ok(html.includes('<li>Item A</li>'));
    assert.ok(html.includes('<ol>'));
    assert.ok(html.includes('<li>Premier</li>'));
  });

  test('styles en ligne (gras, italique)', () => {
    const md = 'Du **texte en gras** et du *texte en italique*.';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<strong>texte en gras</strong>'));
    assert.ok(html.includes('<em>texte en italique</em>'));
  });

  test('wikilinks resolus et cibles absentes (R21, R22)', () => {
    const md = 'Voir [[people/alice]] et [[projects/alpha|Projet Alpha]] ainsi que [[concepts/inexistant|Inconnu]].';
    const isKnownPage = (target) => target === 'people/alice' || target === 'projects/alpha';

    const html = renderMarkdown(md, { isKnownPage });

    // Lien valide sans alias
    assert.ok(
      html.includes(
        '<a href="#page/people%2Falice" class="wikilink" data-target="people/alice">people/alice</a>'
      )
    );
    // Lien valide avec alias
    assert.ok(
      html.includes(
        '<a href="#page/projects%2Falpha" class="wikilink" data-target="projects/alpha">Projet Alpha</a>'
      )
    );
    // Lien casse avec alias
    assert.ok(
      html.includes(
        '<span class="wikilink wikilink-broken" title="Page inexistante : concepts/inexistant">Inconnu</span>'
      )
    );
  });

  test('wikilinks : pas de double echappement HTML pour les alias ou cibles contenant des esperluettes', () => {
    const md = 'Voir [[people/alice|Alice & Bob]] et [[concepts/r&d|Recherche & Developpement]].';
    const isKnownPage = (target) => target === 'concepts/r&d';

    const html = renderMarkdown(md, { isKnownPage });

    // Alias sans double-echappement (&amp; et non &amp;amp;)
    assert.ok(html.includes('Alice &amp; Bob'));
    assert.ok(!html.includes('Alice &amp;amp; Bob'));

    // Cible avec esperluette resolue
    assert.ok(html.includes('data-target="concepts/r&amp;d"'));
    assert.ok(html.includes('href="#page/concepts%2Fr%26d"'));
    assert.ok(html.includes('Recherche &amp; Developpement'));
  });

  test('non-regression : les lignes debutant par # ou | non-table ne provoquent pas de boucle infinie', () => {
    const md = 'Debut\n#hashtag\n| pas une table\nFin';
    const html = renderMarkdown(md);

    assert.ok(html.includes('#hashtag'));
    assert.ok(html.includes('| pas une table'));
  });

  test('robustesse : le rendu s execute sans exception sur le gold ou un echantillon', () => {
    const wikiDir = path.resolve('wiki', 'pro');
    if (!existsSync(wikiDir)) return;

    const folders = readdirSync(wikiDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    let count = 0;
    for (const folder of folders) {
      const folderPath = path.join(wikiDir, folder);
      const files = readdirSync(folderPath).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        const md = readFileSync(path.join(folderPath, f), 'utf8');
        const html = renderMarkdown(md);
        assert.ok(typeof html === 'string');
        count++;
      }
    }

    if (count > 0) {
      assert.ok(count >= 1, `Au moins une page lue : ${count}`);
    }
  });
});
