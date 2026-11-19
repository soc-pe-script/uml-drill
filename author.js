/*
 * UML Drill authoring helpers. No DOM; runs in Node and the browser (window.UMLAuthor).
 * Shared by the in-app author mode and scripts/check.js, so both check questions the same way.
 *
 *   applyPatch(model, patch)        -> diagram     (example patches)
 *   diffPatch(model, diagram)       -> patch       (smallest patch that turns model into diagram)
 *   validateQuestion(q, fileName?)  -> [{ where, msg }]
 *   checkQuestion(q, fileName?)     -> { problems: [{ where, msg, issues? }], passed: [{ where, msg }] }
 *   generateKey(mode, model)        -> key         (draft key that the model answer satisfies)
 *   blankQuestion(id), blankPart(id, mode)
 */
(function (root, factory) {
  const grader = typeof module === 'object' && module.exports ? require('./grader.js') : root.UMLGrader;
  const api = factory(grader);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UMLAuthor = api;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const EDGE_TYPES = ['association', 'composition', 'aggregation', 'inheritance', 'realization', 'dependency', 'link'];
  const ASSOC = ['association', 'composition', 'aggregation'];
  const STEREOS = ['', 'interface', 'abstract', 'enumeration'];
  const ROW_TYPES = ['call', 'return', 'create', 'delete', 'frame', 'else', 'end'];
  const FRAMES = ['loop', 'alt', 'opt', 'par'];
  const isSeq = (d) => !!(d && d.rows);

  // ---------------- patches ----------------

  function applyPatch(model, patch) {
    patch = patch || {};
    if (isSeq(model)) return applySeqPatch(model, patch);
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
    d.nodes = d.nodes.filter((n) => !rmN.has(n.id)).concat(clone(patch.addNodes || []));
    d.edges = d.edges.filter((e) => !rmE.has(e.id) && !rmN.has(e.from) && !rmN.has(e.to)).concat(clone(patch.addEdges || []));
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
    d.lifelines = d.lifelines.filter((l) => !rmL.has(l.id)).concat(clone(patch.addLifelines || []));
    d.rows = d.rows.filter((r) => !rmR.has(r.id) && !rmL.has(r.from) && !rmL.has(r.to));
    for (const { after, row } of patch.addRows || []) {
      const i = after ? d.rows.findIndex((r) => r.id === after) : -1;
      if (after && i < 0) throw new Error(`patch.addRows: no row "${after}"`);
      d.rows.splice(i + 1, 0, clone(row));
    }
    if (patch.order) {
      const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
      if (patch.order.length !== d.rows.length || patch.order.some((id) => !byId[id])) throw new Error('patch.order must list every row id exactly once');
      d.rows = patch.order.map((id) => byId[id]);
    }
    return d;
  }

  /** Fields of b that differ from a (keys missing in b are set to their "empty" value). */
  function fieldDiff(a, b, ignore) {
    const out = {};
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) {
      if (k === 'id' || (ignore && ignore.includes(k))) continue;
      if (same(a[k], b[k])) continue;
      out[k] = b[k] === undefined ? (Array.isArray(a[k]) ? [] : typeof a[k] === 'boolean' ? false : '') : clone(b[k]);
    }
    return out;
  }

  /** Patch that turns model into diagram. Falls back to { diagram } if the round trip fails. */
  function diffPatch(model, diagram) {
    const patch = {};
    const put = (k, v) => { if (Array.isArray(v) ? v.length : Object.keys(v).length) patch[k] = v; };
    if (isSeq(model)) {
      const mL = Object.fromEntries(model.lifelines.map((l) => [l.id, l]));
      const dL = Object.fromEntries(diagram.lifelines.map((l) => [l.id, l]));
      const lf = {};
      diagram.lifelines.forEach((l) => { if (mL[l.id]) { const f = fieldDiff(mL[l.id], l); if (Object.keys(f).length) lf[l.id] = f; } });
      put('lifelines', lf);
      put('removeLifelines', model.lifelines.filter((l) => !dL[l.id]).map((l) => l.id));
      put('addLifelines', diagram.lifelines.filter((l) => !mL[l.id]).map(clone));
      const rmL = new Set(patch.removeLifelines || []);
      const survivors = model.rows.filter((r) => !rmL.has(r.from) && !rmL.has(r.to));
      const mR = Object.fromEntries(survivors.map((r) => [r.id, r]));
      const dR = Object.fromEntries(diagram.rows.map((r) => [r.id, r]));
      const rf = {};
      diagram.rows.forEach((r) => { if (mR[r.id]) { const f = fieldDiff(mR[r.id], r); if (Object.keys(f).length) rf[r.id] = f; } });
      put('rows', rf);
      put('removeRows', model.rows.filter((r) => !rmL.has(r.from) && !rmL.has(r.to) && !dR[r.id]).map((r) => r.id));
      const adds = [];
      diagram.rows.forEach((r, i) => { if (!mR[r.id]) adds.push({ after: i ? diagram.rows[i - 1].id : null, row: clone(r) }); });
      // addRows are applied in order; "after" must already exist, which holds because we walk top to bottom
      put('addRows', adds);
      try {
        const trial = applySeqPatch(model, patch);
        if (!same(trial.rows.map((r) => r.id), diagram.rows.map((r) => r.id))) patch.order = diagram.rows.map((r) => r.id);
      } catch (e) { return { diagram: clone(diagram) }; }
    } else {
      const mN = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
      const dN = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
      const nf = {};
      diagram.nodes.forEach((n) => { if (mN[n.id]) { const f = fieldDiff(mN[n.id], n, ['x', 'y']); if (Object.keys(f).length) nf[n.id] = f; } });
      put('nodes', nf);
      put('removeNodes', model.nodes.filter((n) => !dN[n.id]).map((n) => n.id));
      put('addNodes', diagram.nodes.filter((n) => !mN[n.id]).map(clone));
      const rmN = new Set(patch.removeNodes || []);
      const mE = Object.fromEntries(model.edges.filter((e) => !rmN.has(e.from) && !rmN.has(e.to)).map((e) => [e.id, e]));
      const dE = Object.fromEntries(diagram.edges.map((e) => [e.id, e]));
      const ef = {};
      diagram.edges.forEach((e) => { if (mE[e.id]) { const f = fieldDiff(mE[e.id], e); if (Object.keys(f).length) ef[e.id] = f; } });
      put('edges', ef);
      put('removeEdges', Object.keys(mE).filter((id) => !dE[id]));
      put('addEdges', diagram.edges.filter((e) => !mE[e.id]).map(clone));
    }
    // round-trip check (positions ignored for class/object)
    const strip = (d) => isSeq(d)
      ? { l: d.lifelines.map((l) => ({ ...l })), r: d.rows }
      : { n: d.nodes.map(({ x, y, ...n }) => n).sort((a, b) => (a.id < b.id ? -1 : 1)), e: d.edges.slice().sort((a, b) => (a.id < b.id ? -1 : 1)) };
    try {
      if (same(strip(applyPatch(model, patch)), strip(diagram))) return patch;
    } catch (e) { /* fall through */ }
    return { diagram: clone(diagram) };
  }

  const exampleDiagram = (part, ex) => (ex.diagram ? clone(ex.diagram) : applyPatch(part.model, ex.patch));

  // ---------------- validation ----------------

  function validateDiagram(where, d, out) {
    const fail = (msg) => out.push({ where, msg });
    if (d && d.rows) {
      if (!Array.isArray(d.lifelines)) return fail('needs a "lifelines" array');
      const ids = new Set(['@start']);
      for (const l of d.lifelines) {
        if (!l.id || ids.has(l.id)) fail(`lifeline id "${l.id}" missing or duplicate`);
        ids.add(l.id);
        if (!['object', 'class', 'actor'].includes(l.kind)) fail(`lifeline "${l.id}": kind must be object, class or actor`);
      }
      const rowIds = new Set();
      for (const r of d.rows) {
        if (!r.id || rowIds.has(r.id)) fail(`row id "${r.id}" missing or duplicate`);
        rowIds.add(r.id);
        if (!ROW_TYPES.includes(r.type)) fail(`row "${r.id}": type must be one of ${ROW_TYPES.join(', ')}`);
        if (['call', 'return', 'create', 'delete'].includes(r.type) && (!ids.has(r.from) || !ids.has(r.to))) fail(`row "${r.id}": from/to must be lifeline ids or "@start"`);
        if (r.type === 'frame' && !FRAMES.includes(r.frame)) fail(`row "${r.id}": frame must be loop, alt, opt or par`);
      }
      return;
    }
    if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return fail('needs "nodes" and "edges" arrays');
    const ids = new Set();
    for (const n of d.nodes) {
      if (!n.id) fail('a box has no id');
      if (ids.has(n.id)) fail(`duplicate id "${n.id}"`);
      ids.add(n.id);
      if (!['class', 'object'].includes(n.kind)) fail(`box "${n.id}": kind must be "class" or "object"`);
      if (n.stereo !== undefined && !STEREOS.includes(n.stereo)) fail(`box "${n.id}": stereo must be one of ${STEREOS.join(', ')}`);
      if (typeof n.x !== 'number' || typeof n.y !== 'number') fail(`box "${n.id}": needs numeric x and y`);
      if (!Array.isArray(n.attrs) || !Array.isArray(n.methods)) fail(`box "${n.id}": attrs and methods must be arrays of strings`);
    }
    for (const e of d.edges) {
      if (ids.has(e.id)) fail(`duplicate id "${e.id}"`);
      ids.add(e.id);
      if (!EDGE_TYPES.includes(e.type)) fail(`line "${e.id}": type must be one of ${EDGE_TYPES.join(', ')}`);
      if (!d.nodes.some((n) => n.id === e.from) || !d.nodes.some((n) => n.id === e.to)) fail(`line "${e.id}": from/to must be box ids`);
    }
  }

  function validateQuestion(q, fileName) {
    const out = [];
    const fail = (where, msg) => out.push({ where, msg });
    const where = fileName || (q && q.id ? q.id + '.json' : 'question');
    if (!q || typeof q !== 'object') { fail(where, 'not a question object'); return out; }
    for (const f of ['id', 'title', 'source', 'code', 'parts']) if (q[f] === undefined) fail(where, `missing "${f}"`);
    if (q.id && !/^[a-z0-9-]+$/.test(q.id)) fail(where, 'id must be lowercase letters, digits and dashes');
    if (fileName && q.id && fileName.replace(/^.*[\\/]/, '').replace(/\.json$/, '') !== q.id) fail(where, `file name should be ${q.id}.json`);
    if (!Array.isArray(q.code) || !q.code.every((c) => c.file && typeof c.text === 'string')) fail(where, 'code must be a list of { file, text }');
    if (!Array.isArray(q.parts) || !q.parts.length) fail(where, 'needs at least one part');
    const partIds = new Set();
    (q.parts || []).forEach((p) => {
      const pw = `part ${p.id}`;
      if (partIds.has(p.id)) fail(pw, 'duplicate part id');
      partIds.add(p.id);
      for (const f of ['id', 'mode', 'prompt', 'key', 'model']) if (p[f] === undefined) fail(pw, `missing "${f}"`);
      if (!['class', 'object', 'sequence'].includes(p.mode)) fail(pw, 'mode must be "class", "object" or "sequence"');
      if (p.model) validateDiagram(`${pw} model`, p.model, out);
      if (p.starter) validateDiagram(`${pw} starter`, p.starter, out);
      const k = p.key || {};
      const MISTAKE_FIELDS = ['type', 'toMult', 'fromMult', 'toRole', 'fromRole', 'frame', 'to', 'method'];
      const checkMistakes = (owner, list) => (list || []).forEach((m, i) => {
        const w = `${owner} mistake ${i + 1}`;
        if (!m || typeof m.msg !== 'string' || !m.msg.trim()) fail(pw, `${w}: needs a "msg"`);
        else if (!MISTAKE_FIELDS.some((f) => m[f] !== undefined)) fail(pw, `${w}: say what it matches (${MISTAKE_FIELDS.join(', ')})`);
        if (m && m.credit !== undefined && !(m.credit > 0 && m.credit < 1)) fail(pw, `${w}: credit must be between 0 and 1`);
      });
      for (const r of k.relations || []) checkMistakes(`relation ${r.from}→${r.to}`, r.mistakes);
      const walkM = (items) => (items || []).forEach((e) => {
        checkMistakes(e.frame ? `${e.frame} frame` : e.method ? `${e.method}()` : 'item', e.mistakes);
        walkM(e.body); (e.branches || []).forEach((b) => walkM(b.body));
      });
      walkM(k.body);
      if (p.mode === 'class') {
        for (const r of k.relations || []) {
          if (!EDGE_TYPES.includes(r.type)) fail(pw, `relation ${r.from}→${r.to}: bad type "${r.type}"`);
          if (!k.classes || !k.classes[r.from] || !k.classes[r.to]) fail(pw, `relation ${r.from}→${r.to}: both ends must be listed in the key's classes`);
        }
      }
      if (p.mode === 'sequence') {
        const refs = new Set((k.lifelines || []).map((l) => l.ref));
        if (!k.entry || !refs.has(k.entry.to)) fail(pw, 'the key needs an entry call to a known lifeline');
        const walk = (items) => (items || []).forEach((e) => {
          if (e.call && !refs.has(e.call)) fail(pw, `call to unknown lifeline "${e.call}"`);
          if (e.create && !refs.has(e.create)) fail(pw, `create of unknown lifeline "${e.create}"`);
          if (e.frame && !FRAMES.includes(e.frame)) fail(pw, `bad frame "${e.frame}"`);
          walk(e.body);
          (e.branches || []).forEach((b) => walk(b.body));
        });
        walk(k.body);
      }
      if (p.mode === 'object') {
        const refs = new Set((k.objects || []).map((o) => o.ref));
        for (const l of k.links || []) if (!refs.has(l.a) || !refs.has(l.b)) fail(pw, `link ${l.a}–${l.b}: unknown object`);
      }
    });
    return out;
  }

  /** Same checks as scripts/check.js. */
  function checkQuestion(q, fileName) {
    const problems = validateQuestion(q, fileName);
    const passed = [];
    if (problems.length) return { problems, passed };
    for (const p of q.parts) {
      const res = G.grade(p, p.model);
      if (res.errors) problems.push({ where: `part ${p.id} model`, msg: `the model answer has ${res.errors} error${res.errors === 1 ? '' : 's'}; fix the key or the model`, issues: res.issues });
      else passed.push({ where: `part ${p.id} model`, msg: `model answer: 0 errors, ${res.notes} note${res.notes === 1 ? '' : 's'}`, issues: res.issues });
      for (const ex of p.examples || []) {
        const where = `part ${p.id} example "${ex.name}"`;
        let r;
        try { r = G.grade(p, exampleDiagram(p, ex)); } catch (e) { problems.push({ where, msg: e.message }); continue; }
        const x = ex.expect || {};
        const bad = [];
        if (x.errors !== undefined && r.errors !== x.errors) bad.push(`${r.errors} errors, expected ${x.errors}`);
        if (x.errorsAtLeast !== undefined && r.errors < x.errorsAtLeast) bad.push(`${r.errors} errors, expected at least ${x.errorsAtLeast}`);
        if (x.notes !== undefined && r.notes !== x.notes) bad.push(`${r.notes} notes, expected ${x.notes}`);
        // partial-credit items are only counted when the example says how many to expect
        if (x.partials !== undefined && r.partials !== x.partials) bad.push(`${r.partials} partial, expected ${x.partials}`);
        if (x.score !== undefined && r.score.got !== x.score) bad.push(`score ${r.score.got}/${r.score.max}, expected ${x.score}`);
        if (bad.length) problems.push({ where, msg: bad.join('; '), issues: r.issues });
        else passed.push({ where, msg: `${r.errors} errors, ${r.partials ? r.partials + ' partial, ' : ''}${r.notes} notes · score ${r.score.got}/${r.score.max}`, issues: r.issues });
      }
    }
    return { problems, passed };
  }

  // ---------------- key generation ----------------

  function memberSpec(m, cls) {
    const s = { name: m.name };
    if (m.vis) s.vis = m.vis;
    if (m.isMethod) {
      s.params = (m.params || []).map((p) => (p.name ? { name: p.name, type: p.type } : { type: p.type }));
      if (m.ret && clean(m.ret) !== 'void') s.ret = clean(m.ret);
      if (m.isAbstract) s.abstract = true;
    } else if (m.type) s.type = [clean(m.type)];
    if (m.isStatic) s.static = true;
    return s;
  }

  function classKey(model) {
    const classes = {};
    const nm = {};
    for (const raw of model.nodes) {
      const n = G.normNode(raw);
      nm[raw.id] = n.name;
      if (!n.name || n.kind === 'object') continue;
      const spec = {};
      if (n.stereo) spec.stereo = n.stereo;
      if (n.stereo === 'enumeration') {
        spec.values = n.attrs.map((a) => clean(a).replace(/[,;]$/, ''));
        classes[n.name] = spec;
        continue;
      }
      const attrs = n.attrs.map(G.parseMember).filter((m) => !m.isMethod);
      const methods = n.methods.map(G.parseMember).filter((m) => m.isMethod);
      if (attrs.length) spec.attrs = attrs.map((m) => memberSpec(m, n.name));
      const ctors = methods.filter((m) => m.name === n.name);
      const rest = methods.filter((m) => m.name !== n.name);
      if (rest.length) spec.methods = rest.map((m) => memberSpec(m, n.name));
      if (ctors.length) spec.optionalMethods = ctors.map((m) => memberSpec(m, n.name));
      classes[n.name] = spec;
    }
    const relations = model.edges.filter((e) => nm[e.from] && nm[e.to]).map((e) => {
      const r = { type: e.type, from: nm[e.from], to: nm[e.to] };
      if (ASSOC.includes(e.type)) {
        if (e.navTo && e.navFrom) r.nav = 'both';
        else if (e.navTo) r.nav = 'to';
        else if (e.navFrom) r.nav = 'from';
        if (clean(e.toMult)) r.toMult = [clean(e.toMult)];
        if (clean(e.toRole)) r.toRole = [clean(e.toRole)];
        if (clean(e.fromMult)) r.fromMult = [clean(e.fromMult)];
        if (clean(e.fromRole)) r.fromRole = [clean(e.fromRole)];
      }
      if (e.type === 'dependency') r.optional = true;
      return r;
    });
    return { classes, relations };
  }

  function objectKey(model) {
    const objects = [];
    const refs = {};
    for (const raw of model.nodes) {
      const n = G.normNode(raw);
      if (n.kind !== 'object') continue;
      const i = n.name.indexOf(':');
      const cls = i >= 0 ? clean(n.name.slice(i + 1)) : n.name;
      const o = { ref: raw.id, class: [cls] };
      const attrs = n.attrs.map(G.parseMember).filter((m) => !m.isMethod && m.value != null)
        .map((m) => ({ name: m.name, value: [clean(m.value).replace(/^["'](.*)["']$/, '$1').replace(/^\w+\./, '')] }));
      if (attrs.length) o.attrs = attrs;
      objects.push(o);
      refs[raw.id] = true;
    }
    const links = model.edges.filter((e) => refs[e.from] && refs[e.to]).map((e) => ({ a: e.from, b: e.to }));
    return { objects, links };
  }

  function seqKey(model) {
    const lifes = Object.fromEntries(model.lifelines.map((l) => [l.id, l]));
    const created = new Set(model.rows.filter((r) => r.type === 'create').map((r) => r.to));
    const lifelines = model.lifelines.filter((l) => l.kind !== 'actor').map((l) => {
      const p = G.parseLifeline(l);
      const k = { ref: l.id, class: p.className };
      if (p.isStatic) {
        k.static = true;
        const call = model.rows.find((r) => r.type === 'call' && r.to === l.id);
        if (call) k.staticHint = G.parseCall(call.label).name;
      }
      if (created.has(l.id)) k.created = true;
      return k;
    });
    const tree = G.buildSeqTree(model);
    const outside = (id) => id === G.START || (lifes[id] && lifes[id].kind === 'actor');
    const item = (a) => {
      if (a.kind === 'frame') {
        const f = { frame: a.frame, branches: a.branches.map((b) => ({ guardExample: b.guard ? (b.guard.startsWith('[') ? b.guard : `[${b.guard}]`) : '[condition]', body: a2(b.children) })) };
        return f;
      }
      if (a.kind === 'delete') return null;
      const pc = G.parseCall(a.label);
      const e = a.kind === 'create' ? { create: a.to } : { call: a.to, method: pc.name };
      if (pc.hasParens || a.kind !== 'create') e.args = pc.args.length;
      if (a.ret && a.ret.label && a.kind !== 'create') e.returns = a.ret.label;
      const body = a2(a.children);
      if (body.length) e.body = body;
      return e;
    };
    const a2 = (list) => list.map(item).filter(Boolean);
    const top = tree.root.children;
    const entryNode = top.find((a) => a.kind === 'call' && outside(a.from)) || top.find((a) => a.kind === 'call');
    if (!entryNode) return { lifelines, entry: { to: lifelines[0] ? lifelines[0].ref : '', method: '' }, body: [] };
    const pc = G.parseCall(entryNode.label);
    const entry = { to: entryNode.to, method: pc.name, args: pc.args.length };
    if (entryNode.ret && entryNode.ret.label) entry.returns = entryNode.ret.label;
    return { lifelines, entry, body: a2(entryNode.children) };
  }

  function generateKey(mode, model) {
    if (mode === 'sequence') return seqKey(model);
    if (mode === 'object') return objectKey(model);
    return classKey(model);
  }

  // ---------------- blanks ----------------

  const emptyDiagram = (mode) => (mode === 'sequence' ? { lifelines: [], rows: [] } : { nodes: [], edges: [] });
  const emptyKey = (mode) => (mode === 'sequence' ? { lifelines: [], entry: { to: '', method: '' }, body: [] } : mode === 'object' ? { objects: [], links: [] } : { classes: {}, relations: [] });
  const PROMPTS = {
    class: 'Draw a class diagram to represent the code. Show all attributes, methods, associations, navigabilities, visibilities, known multiplicities, and association roles. Show associations as lines.',
    object: 'Draw an object diagram for the situation where ...',
    sequence: 'Draw a sequence diagram for ... being called on a ... object. Show activation bars and return values.',
  };
  function blankPart(id, mode) {
    return { id, mode, prompt: PROMPTS[mode], canvas: { width: 1000, height: 640 }, starter: emptyDiagram(mode), key: emptyKey(mode), model: emptyDiagram(mode), examples: [] };
  }
  function blankQuestion(id) {
    return { id, title: 'New question', source: 'Original question for UML Drill.', author: '', tags: [], code: [{ file: 'Main.java', text: '' }], parts: [blankPart('a', 'class')] };
  }

  return { applyPatch, diffPatch, exampleDiagram, validateQuestion, checkQuestion, generateKey, blankQuestion, blankPart, emptyDiagram, emptyKey };
});
