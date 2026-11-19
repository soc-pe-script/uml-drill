#!/usr/bin/env node
/*
 * Validates every question in questions/index.json:
 *   1. the file follows the schema (required fields, ids, references)
 *   2. the model answer of every part grades with 0 errors
 *   3. every example (a patched model answer) gives the expected error/note counts
 * The same checks run in the app's author mode (author.js).
 *
 * Usage: node scripts/check.js            (all questions)
 *        node scripts/check.js playlist   (one question by id or file name)
 *        node scripts/check.js -v         (print every issue)
 * Exit code is 1 if anything fails.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { checkQuestion } = require('../author.js');

const QDIR = path.join(__dirname, '..', 'questions');
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const only = args.filter((a) => !a.startsWith('-'));

let failures = 0;
const showIssues = (issues, all) => (issues || []).filter((i) => all || i.sev === 'error')
  .forEach((i) => console.log(`      ${i.sev === 'error' ? 'E' : i.sev === 'partial' ? 'P' : 'n'} [${i.where}] ${i.msg}`));

const index = JSON.parse(fs.readFileSync(path.join(QDIR, 'index.json'), 'utf8'));
const files = fs.readdirSync(QDIR).filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.startsWith('_'));
for (const f of files) if (!index.questions.includes(f)) { failures++; console.log(`  ✗ questions/index.json: ${f} exists but is not listed`); }

for (const file of index.questions) {
  let q;
  try { q = JSON.parse(fs.readFileSync(path.join(QDIR, file), 'utf8')); }
  catch (e) { failures++; console.log(`\n${file}\n  ✗ cannot read: ${e.message}`); continue; }
  if (only.length && !only.some((o) => file.includes(o) || q.id === o)) continue;
  console.log(`\n${file}`);
  const { problems, passed } = checkQuestion(q, file);
  for (const p of passed) { console.log(`  ✓ ${p.where}: ${p.msg}`); if (verbose) showIssues(p.issues, true); }
  for (const p of problems) { failures++; console.log(`  ✗ ${p.where}: ${p.msg}`); showIssues(p.issues, true); }
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
