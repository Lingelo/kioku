/**
 * tools/dashboard/markdown.mjs
 *
 * Moteur de rendu Markdown sur mesure pour le visualiseur du tableau de bord.
 * Zero dependance tierce, securise contre XSS, gere les wikilinks et callouts Obsidian.
 * Calibre sur le gold reel (R20, R21, R22, KTD7).
 */

/**
 * Echappe les caracteres speciaux HTML pour securiser le rendu.
 */
export const escapeHtml = (str) => {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/**
 * Rend les styles en ligne (gras, italique, wikilinks, inline code).
 */
const renderInline = (text, isKnownPage, inlineCodes) => {
  // 1. Extraire les wikilinks avec des placeholders pour eviter le double-echappement HTML
  const wikilinks = [];
  let res = text.replace(/\[\[([^\[\]|#]+)(?:#[^|\]]+)?(?:\|([^\]]+))?\]\]/g, (match, rawTarget, rawAlias) => {
    const target = rawTarget.trim();
    const alias = rawAlias ? rawAlias.trim() : target;
    const known = isKnownPage ? isKnownPage(target) : true;
    const idx = wikilinks.length;

    let rendered;
    if (known) {
      const href = `#page/${encodeURIComponent(target)}`;
      rendered = `<a href="${href}" class="wikilink" data-target="${escapeHtml(target)}">${escapeHtml(alias)}</a>`;
    } else {
      rendered = `<span class="wikilink wikilink-broken" title="Page inexistante : ${escapeHtml(target)}">${escapeHtml(alias)}</span>`;
    }
    wikilinks.push(rendered);
    return `%%WIKILINK_${idx}%%`;
  });

  // 2. Echapper le reste du texte
  res = escapeHtml(res);

  // 3. Gras : **texte**
  res = res.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 4. Italique : *texte*
  res = res.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 5. Restauration des wikilinks
  res = res.replace(/%%WIKILINK_(\d+)%%/g, (match, idx) => {
    return wikilinks[Number(idx)] ?? match;
  });

  // 6. Restauration de l'inline code
  res = res.replace(/%%INLINECODE_(\d+)%%/g, (match, idx) => {
    return inlineCodes[Number(idx)] ?? match;
  });

  return res;
};

/**
 * Rend un bloc de lignes Markdown en HTML.
 */
const renderBlocks = (lines, isKnownPage, inlineCodes, codeBlocks) => {
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Ligne vide
    if (!trimmed) {
      i++;
      continue;
    }

    // Placeholder de bloc de code
    const codeMatch = trimmed.match(/^%%CODEBLOCK_(\d+)%%$/);
    if (codeMatch) {
      output.push(codeBlocks[Number(codeMatch[1])]);
      i++;
      continue;
    }

    // Titres : # a ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2], isKnownPage, inlineCodes);
      output.push(`<h${level}>${content}</h${level}>`);
      i++;
      continue;
    }

    // Regle horizontale : --- ou ***
    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      output.push('<hr />');
      i++;
      continue;
    }

    // Tableaux Markdown : ligne debutant et finissant par |
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (nextTrimmed.startsWith('|') && nextTrimmed.endsWith('|') && /^\|(?:\s*:?-+:?\s*\|)+$/.test(nextTrimmed)) {
        // En-tete
        const parseRow = (r) =>
          r
            .trim()
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim());

        const headers = parseRow(trimmed);
        i += 2; // Sauter la ligne d'en-tete et la ligne separateur

        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          rows.push(parseRow(lines[i]));
          i++;
        }

        let tableHtml = '<table>\n<thead>\n<tr>\n';
        for (const h of headers) {
          tableHtml += `<th>${renderInline(h, isKnownPage, inlineCodes)}</th>\n`;
        }
        tableHtml += '</tr>\n</thead>\n<tbody>\n';
        for (const row of rows) {
          tableHtml += '<tr>\n';
          for (const cell of row) {
            tableHtml += `<td>${renderInline(cell, isKnownPage, inlineCodes)}</td>\n`;
          }
          tableHtml += '</tr>\n';
        }
        tableHtml += '</tbody>\n</table>';
        output.push(tableHtml);
        continue;
      }
    }

    // Callouts Obsidian ou Blockquotes
    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        const raw = lines[i].trim().replace(/^>\s?/, '');
        quoteLines.push(raw);
        i++;
      }

      // Verifier si callout Obsidian : [!type] Titre optionnel
      const firstLine = quoteLines[0] || '';
      const calloutMatch = firstLine.match(/^\[!([a-zA-Z0-9_-]+)\](?:\s*(.*))?$/);

      if (calloutMatch) {
        const type = calloutMatch[1].toLowerCase();
        const defaultTitle = type.charAt(0).toUpperCase() + type.slice(1);
        const titleText = calloutMatch[2] ? calloutMatch[2].trim() : defaultTitle;
        const bodyLines = quoteLines.slice(1);

        const renderedTitle = renderInline(titleText, isKnownPage, inlineCodes);
        const bodyHtml = renderBlocks(bodyLines, isKnownPage, inlineCodes, codeBlocks);

        output.push(
          `<div class="callout callout-${type}">\n<div class="callout-title">${renderedTitle}</div>\n<div class="callout-content">\n${bodyHtml}\n</div>\n</div>`
        );
      } else {
        // Citation standard
        const quoteHtml = renderBlocks(quoteLines, isKnownPage, inlineCodes, codeBlocks);
        output.push(`<blockquote>\n${quoteHtml}\n</blockquote>`);
      }
      continue;
    }

    // Listes a puces (- ou *)
    if (/^[-*]\s+/.test(trimmed)) {
      const listItems = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^[-*]\s+/, '');
        listItems.push(itemText);
        i++;
      }
      let ulHtml = '<ul>\n';
      for (const item of listItems) {
        ulHtml += `<li>${renderInline(item, isKnownPage, inlineCodes)}</li>\n`;
      }
      ulHtml += '</ul>';
      output.push(ulHtml);
      continue;
    }

    // Listes ordonnees (1. 2. ...)
    if (/^\d+\.\s+/.test(trimmed)) {
      const listItems = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, '');
        listItems.push(itemText);
        i++;
      }
      let olHtml = '<ol>\n';
      for (const item of listItems) {
        olHtml += `<li>${renderInline(item, isKnownPage, inlineCodes)}</li>\n`;
      }
      olHtml += '</ol>';
      output.push(olHtml);
      continue;
    }

    // Paragraphe standard : groupe de lignes consecutives
    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('>') &&
      !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('%%CODEBLOCK_') &&
      !/^(?:---|\*\*\*|___)$/.test(lines[i].trim())
    ) {
      pLines.push(lines[i].trim());
      i++;
    }

    if (pLines.length === 0 && i < lines.length) {
      // Cas de repli : la ligne n'a matche aucun bloc specifique (ex: hashtag sans espace ou pipe isole)
      // On l'avance et on la traite en paragraphe pour garantir la terminaison
      pLines.push(lines[i].trim());
      i++;
    }

    if (pLines.length > 0) {
      const pText = pLines.map((l) => renderInline(l, isKnownPage, inlineCodes)).join('<br />');
      output.push(`<p>${pText}</p>`);
    }
  }

  return output.join('\n\n');
};

/**
 * Rend un document Markdown en HTML securise.
 *
 * @param {string} markdown - Contenu markdown source
 * @param {object} [options]
 * @param {function} [options.isKnownPage] - Predicat verifiant l'existence d'une cible wikilink
 * @param {boolean} [options.stripFrontmatter=true] - Si vrai, retire le frontmatter YAML initial
 * @returns {string} HTML produit
 */
export const renderMarkdown = (markdown, options = {}) => {
  if (typeof markdown !== 'string') return '';

  let text = markdown.replace(/\r\n/g, '\n');

  // 1. Suppression du frontmatter YAML si present
  if (options.stripFrontmatter !== false) {
    text = text.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?/, '');
  }

  // 2. Extraction des blocs de code fenced (```lang ... ```)
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    const escapedCode = escapeHtml(code);
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${langClass}>${escapedCode}</code></pre>`);
    return `\n\n%%CODEBLOCK_${idx}%%\n\n`;
  });

  // 3. Extraction du code inline (`...`)
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINECODE_${idx}%%`;
  });

  // 4. Decoupage en lignes et rendu des blocs
  const lines = text.split('\n');
  return renderBlocks(lines, options.isKnownPage, inlineCodes, codeBlocks);
};
