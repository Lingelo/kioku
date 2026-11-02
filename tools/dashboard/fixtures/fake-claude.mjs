#!/usr/bin/env node
/**
 * Faux `claude` des tests de l'onglet 問 Question : aucune vraie session n'est jamais lancee.
 *
 * Il impose le contrat du vrai CLI qui compte ici (`stream-json` en `-p` exige `--verbose`), consigne ce
 * qu'il a recu (arguments, stdin, cwd, environnement utile) dans FAKE_CLAUDE_RECORD, puis joue le
 * scenario FAKE_CLAUDE_SCENARIO :
 *   ok     deux lectures (dont une hors du domaine), trois fragments, un resultat
 *   fail   sortie en code 1, sans resultat
 *   hang   un fragment, puis attend d'etre tue
 *   wait   une lecture, aucun texte, attend d'etre tue (demo de l'attente)
 *   html   resultat contenant du HTML brut et un wikilink
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'ok';
const vault = process.cwd();

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_RECORD) {
    appendFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({
        args,
        stdin,
        cwd: process.cwd(),
        projectDir: process.env.CLAUDE_PROJECT_DIR,
        mode: process.env.VAULT_MODE,
        domain: process.env.VAULT_DOMAIN,
        path: process.env.PATH,
      }) + '\n'
    );
  }

  if (args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'stream-json' && !args.includes('--verbose')) {
    process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
    process.exit(1);
  }

  const domain = process.env.VAULT_DOMAIN;
  emit({ type: 'system', subtype: 'init', session_id: 'x' });
  if (scenario === 'fail') process.exit(1);

  const read = (file, parent = null) =>
    emit({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });
  const text = (t) =>
    emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

  if (scenario === 'wait') {
    read(path.join(vault, 'wiki', domain, 'index.md'));
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'hang') {
    text('Debut');
    setInterval(() => {}, 1000);
    return;
  }

  read(path.join(vault, 'wiki', domain, 'index.md'));
  read(path.join(vault, 'wiki', domain, 'projects', 'atlas.md'));
  read(path.join(vault, 'wiki', domain, 'projects', 'atlas.md')); // relue : comptee une fois
  read(path.join(vault, 'raw', domain, 'meetings', 'x.md')); // hors de l'or : ignoree
  read(path.join(vault, 'wiki', domain, 'people', 'y.md'), 'toolu_sub'); // sous-agent : ignoree
  text('La v2 ');
  text('est ');
  text('livree.');
  const result = scenario === 'html' ? 'Voir [[projects/atlas]] <script>alert(1)</script>' : 'La v2 est livree.';
  emit({ type: 'result', subtype: 'success', is_error: false, result });
});
