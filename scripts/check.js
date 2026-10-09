#!/usr/bin/env node
/*
 * Validates every question in questions/index.json:
 *   1. the file follows the schema (required fields, ids, references)
 *   2. the model answer of every part grades with 0 errors
 *   3. every example (a patched model answer) gives the expected error/note counts
 *
 * Usage: node scripts/check.js            (all questions)
 *        node scripts/check.js playlist   (one question by id or file name)
 *        node scripts/check.js -v         (print every issue)
 * Exit code is 1 if anything fails.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { grade } = require('../grader.js');

const ROOT = path.join(__dirname, '..');
const QDIR = path.join(ROOT, 'questions');
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const only = args.filter((a) => !a.startsWith('-'));

const EDGE_TYPES = ['association', 'composition', 'aggregation', 'inheritance', 'realization', 'dependency', 'link'];
const STEREOS = ['', 'interface', 'abstract', 'enumeration'];

let failures = 0;
const fail = (where, msg) => { failures++; console.log(`  ✗ ${where}: ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

function applyPatch(model, patch = {}) {
  if (model.rows) return applySeqPatch(model, patch);
  const d = clone(model);
  for (const [id, fields] of Object.entries(patch.nodes || {})) {
    const n = d.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`patch.nodes: no node "${id}"`);
    Object.assign(n, fields);
  }
  for (const [id, fields] of Object.entries(patch.edges || {})) {
    const e = d.edges.find((x) => x.id === id);
    if (!e) throw new Error(`patch.edges: no edge "${id}"`);
    Object.assign(e, fields);
  }
  const rmN = new Set(patch.removeNodes || []);
  const rmE = new Set(patch.removeEdges || []);
  d.nodes = d.nodes.filter((n) => !rmN.has(n.id)).concat(patch.addNodes || []);
  d.edges = d.edges.filter((e) => !rmE.has(e.id) && !rmN.has(e.from) && !rmN.has(e.to)).concat(patch.addEdges || []);
  return d;
}

function applySeqPatch(model, patch) {
  const d = clone(model);
  for (const [id, fields] of Object.entries(patch.lifelines || {})) {
    const l = d.lifelines.find((x) => x.id === id);
    if (!l) throw new Error(`patch.lifelines: no lifeline "${id}"`);
    Object.assign(l, fields);
  }
  for (const [id, fields] of Object.entries(patch.rows || {})) {
    const r = d.rows.find((x) => x.id === id);
    if (!r) throw new Error(`patch.rows: no row "${id}"`);
    Object.assign(r, fields);
  }
  const rmL = new Set(patch.removeLifelines || []);
  const rmR = new Set(patch.removeRows || []);
  d.lifelines = d.lifelines.filter((l) => !rmL.has(l.id)).concat(patch.addLifelines || []);
  d.rows = d.rows.filter((r) => !rmR.has(r.id) && !rmL.has(r.from) && !rmL.has(r.to));
  for (const { after, row } of patch.addRows || []) {
    const i = after ? d.rows.findIndex((r) => r.id === after) : -1;
    if (after && i < 0) throw new Error(`patch.addRows: no row "${after}"`);
    d.rows.splice(i + 1, 0, row);
  }
  if (patch.order) {
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    if (patch.order.length !== d.rows.length || patch.order.some((id) => !byId[id])) throw new Error('patch.order must list every row id exactly once');
    d.rows = patch.order.map((id) => byId[id]);
  }
  return d;
}

const ROW_TYPES = ['call', 'return', 'create', 'delete', 'frame', 'else', 'end'];
function validateSeq(where, d) {
  if (!d || !Array.isArray(d.lifelines) || !Array.isArray(d.rows)) return fail(where, 'needs "lifelines" and "rows" arrays');
  const ids = new Set(['@start']);
  for (const l of d.lifelines) {
    if (!l.id || ids.has(l.id)) fail(where, `lifeline id "${l.id}" missing or duplicate`);
    ids.add(l.id);
    if (!['object', 'class', 'actor'].includes(l.kind)) fail(where, `lifeline "${l.id}": kind must be object, class or actor`);
  }
  const rowIds = new Set();
  for (const r of d.rows) {
    if (!r.id || rowIds.has(r.id)) fail(where, `row id "${r.id}" missing or duplicate`);
    rowIds.add(r.id);
    if (!ROW_TYPES.includes(r.type)) fail(where, `row "${r.id}": type must be one of ${ROW_TYPES.join(', ')}`);
    if (['call', 'return', 'create', 'delete'].includes(r.type) && (!ids.has(r.from) || !ids.has(r.to))) fail(where, `row "${r.id}": from/to must be lifeline ids or "@start"`);
    if (r.type === 'frame' && !['loop', 'alt', 'opt', 'par'].includes(r.frame)) fail(where, `row "${r.id}": frame must be loop, alt, opt or par`);
  }
}

function validateDiagram(where, d) {
  if (d && d.rows) return validateSeq(where, d);
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return fail(where, 'needs "nodes" and "edges" arrays');
  const ids = new Set();
  for (const n of d.nodes) {
    if (!n.id) fail(where, 'a node has no id');
    if (ids.has(n.id)) fail(where, `duplicate id "${n.id}"`);
    ids.add(n.id);
    if (!['class', 'object'].includes(n.kind)) fail(where, `node "${n.id}": kind must be "class" or "object"`);
    if (n.stereo !== undefined && !STEREOS.includes(n.stereo)) fail(where, `node "${n.id}": stereo must be one of ${STEREOS.join(', ')}`);
    if (typeof n.x !== 'number' || typeof n.y !== 'number') fail(where, `node "${n.id}": needs numeric x and y`);
    if (!Array.isArray(n.attrs) || !Array.isArray(n.methods)) fail(where, `node "${n.id}": attrs and methods must be arrays of strings`);
  }
  for (const e of d.edges) {
    if (ids.has(e.id)) fail(where, `duplicate id "${e.id}"`);
    ids.add(e.id);
    if (!EDGE_TYPES.includes(e.type)) fail(where, `edge "${e.id}": type must be one of ${EDGE_TYPES.join(', ')}`);
    if (!d.nodes.some((n) => n.id === e.from) || !d.nodes.some((n) => n.id === e.to)) fail(where, `edge "${e.id}": from/to must be node ids`);
  }
}

function validateQuestion(file, q) {
  const where = file;
  for (const f of ['id', 'title', 'source', 'code', 'parts']) if (q[f] === undefined) fail(where, `missing "${f}"`);
  if (q.id && !/^[a-z0-9-]+$/.test(q.id)) fail(where, 'id must be lowercase letters, digits and dashes');
  if (q.id && path.basename(file, '.json') !== q.id) fail(where, `file name should be ${q.id}.json`);
  if (!Array.isArray(q.code) || !q.code.every((c) => c.file && typeof c.text === 'string')) fail(where, 'code must be [{ file, text }]');
  (q.parts || []).forEach((p) => {
    const pw = `${where} part ${p.id}`;
    for (const f of ['id', 'mode', 'prompt', 'key', 'model']) if (p[f] === undefined) fail(pw, `missing "${f}"`);
    if (!['class', 'object', 'sequence'].includes(p.mode)) fail(pw, 'mode must be "class", "object" or "sequence"');
    validateDiagram(`${pw} model`, p.model);
    if (p.starter) validateDiagram(`${pw} starter`, p.starter);
    if (p.mode === 'class' && p.key) {
      for (const r of p.key.relations || []) {
        if (!EDGE_TYPES.includes(r.type)) fail(pw, `relation ${r.from}→${r.to}: bad type "${r.type}"`);
        if (!p.key.classes || !p.key.classes[r.from] || !p.key.classes[r.to]) fail(pw, `relation ${r.from}→${r.to}: both ends must be listed in key.classes`);
      }
    }
    if (p.mode === 'sequence' && p.key) {
      const refs = new Set((p.key.lifelines || []).map((l) => l.ref));
      if (!p.key.entry || !refs.has(p.key.entry.to)) fail(pw, 'key.entry.to must be a lifeline ref');
      const walk = (items) => (items || []).forEach((e) => {
        if (e.call && !refs.has(e.call)) fail(pw, `call to unknown ref "${e.call}"`);
        if (e.create && !refs.has(e.create)) fail(pw, `create of unknown ref "${e.create}"`);
        if (e.frame && !['loop', 'alt', 'opt', 'par'].includes(e.frame)) fail(pw, `bad frame "${e.frame}"`);
        walk(e.body);
        (e.branches || []).forEach((b) => walk(b.body));
      });
      walk(p.key.body);
    }
    if (p.mode === 'object' && p.key) {
      const refs = new Set((p.key.objects || []).map((o) => o.ref));
      for (const l of p.key.links || []) if (!refs.has(l.a) || !refs.has(l.b)) fail(pw, `link ${l.a}–${l.b}: unknown object ref`);
    }
  });
}

function show(res) {
  if (!verbose) return;
  for (const i of res.issues) console.log(`      ${i.sev === 'error' ? 'E' : 'n'} [${i.where}] ${i.msg}`);
}

const index = JSON.parse(fs.readFileSync(path.join(QDIR, 'index.json'), 'utf8'));
const files = fs.readdirSync(QDIR).filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.startsWith('_'));
for (const f of files) if (!index.questions.includes(f)) fail('questions/index.json', `${f} exists but is not listed`);

for (const file of index.questions) {
  const q = JSON.parse(fs.readFileSync(path.join(QDIR, file), 'utf8'));
  if (only.length && !only.some((o) => file.includes(o) || q.id === o)) continue;
  console.log(`\n${file}`);
  validateQuestion(file, q);
  for (const p of q.parts || []) {
    const res = grade(p, p.model);
    if (res.errors === 0) ok(`part ${p.id}: model answer has 0 errors (${res.notes} notes)`);
    else { fail(`part ${p.id} model`, `${res.errors} errors in the model answer`); verbose || res.issues.filter((i) => i.sev === 'error').forEach((i) => console.log(`      E [${i.where}] ${i.msg}`)); }
    show(res);
    for (const ex of p.examples || []) {
      let r;
      try { r = grade(p, applyPatch(p.model, ex.patch)); } catch (e) { fail(`part ${p.id} "${ex.name}"`, e.message); continue; }
      const x = ex.expect || {};
      const problems = [];
      if (x.errors !== undefined && r.errors !== x.errors) problems.push(`errors ${r.errors}, expected ${x.errors}`);
      if (x.errorsAtLeast !== undefined && r.errors < x.errorsAtLeast) problems.push(`errors ${r.errors}, expected at least ${x.errorsAtLeast}`);
      if (x.notes !== undefined && r.notes !== x.notes) problems.push(`notes ${r.notes}, expected ${x.notes}`);
      if (problems.length) {
        fail(`part ${p.id} "${ex.name}"`, problems.join('; '));
        r.issues.forEach((i) => console.log(`      ${i.sev === 'error' ? 'E' : 'n'} [${i.where}] ${i.msg}`));
      } else { ok(`part ${p.id} example "${ex.name}" (${r.errors} errors, ${r.notes} notes)`); show(r); }
    }
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
