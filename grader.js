/*
 * UML Drill grader.
 * Pure functions, no DOM. Works in the browser (window.UMLGrader) and in Node (require).
 *
 * grade(part, diagram) -> { errors, notes, issues: [{ sev: 'error'|'note', where, msg, ref }] }
 *   part    = one entry of a question's "parts" array (has mode, key)
 *   diagram = { nodes: [...], edges: [...] } as saved by the editor
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UMLGrader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VIS = '+-#~';
  const VIS_WORD = { '+': 'public (+)', '-': 'private (-)', '#': 'protected (#)', '~': 'package (~)' };
  const ASSOC_TYPES = ['association', 'composition', 'aggregation'];
  const DIRECTED_TYPES = ['inheritance', 'realization', 'dependency'];
  const TYPE_WORD = {
    association: 'association (solid line)',
    composition: 'composition (filled diamond)',
    aggregation: 'aggregation (hollow diamond)',
    inheritance: 'inheritance (solid line, hollow triangle)',
    realization: 'realization (dashed line, hollow triangle)',
    dependency: 'dependency (dashed arrow)',
    link: 'link (plain line)',
  };

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const squash = (s) => clean(s).replace(/\s+/g, '');
  const unquote = (s) => clean(s).replace(/^["'](.*)["']$/, '$1');

  function normMult(m) {
    let s = squash(m);
    if (s === '0..*' || s === '*..*') s = '*';
    if (s === '1..1') s = '1';
    return s;
  }

  // ---------- parsing ----------

  /** Box header text -> { text, stereo, abstract } ; strips <<...>> and {abstract}. */
  function parseHeader(raw) {
    let stereo = '';
    let abstract = false;
    let s = clean(raw)
      .replace(/<<\s*([\w ]+?)\s*>>|«\s*([\w ]+?)\s*»/g, (_, a, b) => { stereo = (a || b).toLowerCase(); return ' '; })
      .replace(/\{\s*abstract\s*\}/gi, () => { abstract = true; return ' '; });
    if (stereo === 'enum') stereo = 'enumeration';
    return { text: clean(s), stereo, abstract };
  }

  function normNode(n) {
    const h = parseHeader(n.name);
    let stereo = n.stereo || '';
    if (h.stereo) stereo = h.stereo;
    if (h.abstract && !stereo) stereo = 'abstract';
    const out = {
      id: n.id,
      kind: n.kind === 'object' ? 'object' : 'class',
      stereo,
      name: h.text,
      attrs: (n.attrs || []).map(clean).filter(Boolean),
      methods: (n.methods || []).map(clean).filter(Boolean),
    };
    if (out.kind === 'object') {
      const i = out.name.indexOf(':');
      out.objName = i >= 0 ? clean(out.name.slice(0, i)) : '';
      out.className = i >= 0 ? clean(out.name.slice(i + 1)) : '';
      out.hasColon = i >= 0;
    }
    return out;
  }

  /**
   * Parse one member line. Accepts UML ("-name: String", "+add(s: Item): void")
   * and flags Java style ("private String name", "int getCount()").
   */
  function parseMember(raw) {
    let s = clean(raw);
    const m = { raw: s, vis: null, isStatic: false, isAbstract: false, javaStyle: false };
    if (/\{\s*static\s*\}/i.test(s)) { m.isStatic = true; s = clean(s.replace(/\{\s*static\s*\}/gi, '')); }
    if (s.length > 2 && s[0] === '_' && s[s.length - 1] === '_') { m.isStatic = true; s = clean(s.slice(1, -1)); }
    if (/\{\s*abstract\s*\}/i.test(s)) { m.isAbstract = true; s = clean(s.replace(/\{\s*abstract\s*\}/gi, '')); }
    s = s.replace(/;$/, '');
    if (s && VIS.includes(s[0])) { m.vis = s[0]; s = clean(s.slice(1)); }
    // Java keywords
    let kw;
    while ((kw = s.match(/^(public|private|protected|static|final|abstract)\s+/))) {
      m.javaStyle = true;
      if (kw[1] === 'public') m.vis = m.vis || '+';
      if (kw[1] === 'private') m.vis = m.vis || '-';
      if (kw[1] === 'protected') m.vis = m.vis || '#';
      if (kw[1] === 'static') m.isStatic = true;
      if (kw[1] === 'abstract') m.isAbstract = true;
      s = s.slice(kw[0].length);
    }
    const paren = s.indexOf('(');
    if (paren >= 0 && s.indexOf(')', paren) > paren) {
      m.isMethod = true;
      const close = s.lastIndexOf(')');
      const head = clean(s.slice(0, paren));
      const inner = s.slice(paren + 1, close);
      const tail = clean(s.slice(close + 1));
      const headParts = head.split(' ');
      m.name = headParts.pop();
      if (headParts.length) { m.javaStyle = true; m.ret = headParts.join(' '); }
      if (tail.startsWith(':')) m.ret = clean(tail.slice(1));
      m.params = splitParams(inner).map((p) => {
        if (p.includes(':')) {
          const i = p.indexOf(':');
          return { name: clean(p.slice(0, i)), type: clean(p.slice(i + 1)) };
        }
        const parts = clean(p).split(' ');
        if (parts.length >= 2) { m.javaStyle = true; return { name: parts.pop(), type: parts.join(' '), java: true }; }
        return { name: '', type: parts[0] };
      });
    } else {
      m.isMethod = false;
      let value;
      const eq = s.indexOf('=');
      if (eq >= 0) { value = clean(s.slice(eq + 1)); s = clean(s.slice(0, eq)); }
      let type;
      const colon = s.indexOf(':');
      if (colon >= 0) { type = clean(s.slice(colon + 1)); s = clean(s.slice(0, colon)); }
      const parts = s.split(' ');
      m.name = parts.pop();
      if (parts.length) { m.javaStyle = true; type = type || parts.join(' '); }
      m.type = type;
      m.value = value;
    }
    return m;
  }

  function splitParams(inner) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of inner) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (clean(cur)) out.push(cur);
    return out.map(clean).filter(Boolean);
  }

  // ---------- helpers ----------

  // Severities: error (costs 1 mark), partial (half right: costs 1 - credit), note (free).
  function makeReporter() {
    const issues = [];
    return {
      issues,
      error: (where, msg, ref) => issues.push({ sev: 'error', where, msg, ref: ref || null }),
      note: (where, msg, ref) => issues.push({ sev: 'note', where, msg, ref: ref || null }),
      partial: (where, msg, ref, cost) => issues.push({ sev: 'partial', where, msg, ref: ref || null, cost }),
    };
  }

  const listOf = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);
  const typeIn = (t, list) => listOf(list).map(squash).includes(squash(t));
  const sigOf = (m) => `${m.vis || ''}${m.name}(${(m.params || []).map((p) => p.type).join(', ')})`;
  const costOf = (i) => (i.sev === 'error' ? 1 : i.sev === 'partial' ? i.cost : 0);

  /**
   * Known mistakes from the key: [{ <field>: value, msg, credit? }]. When the drawing matches one,
   * its msg replaces the generic message. With credit (0..1) it is a partial, not an error.
   */
  function findMistake(list, field, val, norm) {
    const f = norm || clean;
    return (list || []).find((m) => m[field] !== undefined && listOf(m[field]).some((v) => f(v) === f(val)));
  }
  function reportMistake(rep, where, m, ref) {
    if (m.credit > 0 && m.credit < 1) rep.partial(where, m.msg, ref, Math.round((1 - m.credit) * 100) / 100);
    else rep.error(where, m.msg, ref);
  }

  /** Marks available in a part: one per thing the key asks for, unless the part sets "marks". */
  function maxMarks(part) {
    if (part.marks > 0) return part.marks;
    const k = part.key || {};
    if (part.mode === 'sequence') {
      const count = (items) => (items || []).reduce((s, e) => s + 1 + count(e.body) + (e.branches || []).reduce((t, b) => t + count(b.body), 0), 0);
      return (k.lifelines || []).length + 1 + count(k.body);
    }
    if (part.mode === 'object') {
      return (k.objects || []).reduce((s, o) => s + 1 + (o.attrs || []).length, 0) + (k.links || []).length;
    }
    if (part.mode === 'activity') {
      // each action, the start node, an end node, and each flow the key requires
      return (k.actions || []).length + 2 + (k.flows || []).filter((f) => !f.optional).length;
    }
    const cls = Object.values(k.classes || {}).reduce((s, c) => s + 1 + (c.attrs || []).length + (c.methods || []).length + (c.values ? 1 : 0), 0);
    const rels = (k.relations || []).filter((r) => !r.optional).reduce((s, r) => s + (r.orTwoLines ? 2 : 1), 0);
    return cls + rels;
  }

  function summarize(issues, max) {
    const lost = issues.reduce((s, i) => s + costOf(i), 0);
    return {
      errors: issues.filter((i) => i.sev === 'error').length,
      partials: issues.filter((i) => i.sev === 'partial').length,
      notes: issues.filter((i) => i.sev === 'note').length,
      score: { got: Math.max(0, Math.round((max - lost) * 2) / 2), max },
      issues,
    };
  }

  // ---------- class diagrams ----------

  function checkVis(r, where, m, want, ref) {
    if (!want) return;
    if (!m.vis) r.error(where, `"${m.raw}": add the visibility, ${VIS_WORD[want]}.`, ref);
    else if (m.vis !== want) r.error(where, `"${m.raw}": visibility should be ${VIS_WORD[want]}, not ${m.vis}.`, ref);
  }

  function checkAttr(r, cls, spec, m, ref) {
    const where = cls;
    if (m.javaStyle) r.error(where, `"${m.raw}" is written in Java style. UML puts the type after the name: ${spec.vis || ''}${spec.name}: ${listOf(spec.type)[0]}.`, ref);
    checkVis(r, where, m, spec.vis, ref);
    if (spec.type) {
      if (!m.type) r.error(where, `"${m.raw}": add the type, e.g. ${spec.name}: ${listOf(spec.type)[0]}.`, ref);
      else if (!typeIn(m.type, spec.type)) r.error(where, `"${m.raw}": type should be ${listOf(spec.type).join(' or ')}.`, ref);
    }
    if (spec.static && !m.isStatic) r.error(where, `"${m.raw}" is static (class-level). Underline it: write {static} or wrap it in _underscores_.`, ref);
    if (!spec.static && m.isStatic) r.error(where, `"${m.raw}" is not static; remove the underline.`, ref);
  }

  function checkMethod(r, cls, clsStereo, spec, m, ref) {
    const where = cls;
    const isCtor = spec.name === cls;
    if (m.javaStyle) r.error(where, `"${m.raw}" is written in Java style. UML form: ${spec.vis || ''}${spec.name}(${(spec.params || []).map((p) => (p.name ? p.name + ': ' : '') + p.type).join(', ')})${spec.ret ? ': ' + spec.ret : ''}.`, ref);
    checkVis(r, where, m, spec.vis, ref);

    const want = spec.params || [];
    const got = m.params || [];
    if (want.length !== got.length) {
      r.error(where, `"${m.raw}": should take ${want.length} parameter${want.length === 1 ? '' : 's'} (${want.map((p) => p.type).join(', ') || 'none'}).`, ref);
    } else {
      want.forEach((p, i) => {
        const g = got[i];
        if (!typeIn(g.type, p.type)) r.error(where, `"${m.raw}": parameter ${i + 1} should be of type ${listOf(p.type).join(' or ')}.`, ref);
        else if (!g.name && !m.javaStyle) r.note(where, `"${m.raw}": parameter type alone is usually accepted. Full UML form names it, e.g. ${p.name || 'x'}: ${listOf(p.type)[0]}.`, ref);
      });
    }

    if (isCtor) {
      if (m.ret) r.error(where, `"${m.raw}": constructors have no return type.`, ref);
    } else if (spec.ret && squash(spec.ret) !== 'void') {
      if (!m.ret) r.error(where, `"${m.raw}": add the return type, ": ${spec.ret}".`, ref);
      else if (!typeIn(m.ret, spec.ret)) r.error(where, `"${m.raw}": return type should be ${spec.ret}.`, ref);
    } else if (m.ret && squash(m.ret) !== 'void') {
      r.error(where, `"${m.raw}": returns nothing (void); remove ": ${m.ret}".`, ref);
    }

    if (spec.abstract === true && !m.isAbstract) r.error(where, `"${m.raw}" is abstract. Mark it {abstract} (or italics on paper).`, ref);
    if (spec.abstract !== true && spec.abstract !== 'any' && clsStereo !== 'interface' && m.isAbstract) r.error(where, `"${m.raw}" is not abstract here; remove {abstract}.`, ref);
    if (spec.static && !m.isStatic) r.error(where, `"${m.raw}" is static. Underline it: {static} or _underscores_.`, ref);
    if (!spec.static && m.isStatic) r.error(where, `"${m.raw}" is not static; remove the underline.`, ref);
  }

  const STEREO_FIX = {
    interface: 'Mark it as an interface: <<interface>> above the name.',
    abstract: 'Mark it as abstract: {abstract} above the name (or italic name on paper).',
    enumeration: 'Mark it as an enumeration: <<enumeration>> above the name.',
    '': 'It is a plain class; remove the stereotype or {abstract}.',
  };

  function relDesc(r) {
    return `${r.from} → ${r.to}`;
  }

  /** Evaluate one drawn edge against one key relation. Returns issue list (not yet reported). */
  function evalEdge(rel, e, names) {
    const local = makeReporter();
    const where = relDesc(rel);
    const ref = { edge: e.id };
    const accepted = [rel.type].concat(rel.acceptTypes || []);
    const forward = names[e.from] === rel.from;

    if (!accepted.includes(e.type)) {
      const mk = findMistake(rel.mistakes, 'type', e.type);
      if (mk) reportMistake(local, where, mk, ref);
      else local.error(where, `Wrong kind of line: drew ${TYPE_WORD[e.type] || e.type}, expected ${TYPE_WORD[rel.type]}.${rel.typeHint ? ' ' + rel.typeHint : ''}`, ref);
      // a half-right line type is still checked for direction, multiplicity and roles
      if (!mk || !(mk.credit > 0)) return local.issues;
    }
    if (rel.acceptTypes && e.type !== rel.type && accepted.includes(e.type) && rel.acceptNote) local.note(where, rel.acceptNote, ref);

    if (DIRECTED_TYPES.includes(e.type) && !forward) {
      local.error(where, `Arrow points the wrong way. It should go from ${rel.from} to ${rel.to}.`, ref);
    }
    if ((e.type === 'composition' || e.type === 'aggregation') && !forward) {
      local.error(where, `The diamond belongs at the whole (${rel.from}) end.`, ref);
    }

    const atTo = forward ? 'to' : 'from';
    const atFrom = forward ? 'from' : 'to';
    const navAt = (end) => (end === 'to' ? !!e.navTo : !!e.navFrom);

    if (ASSOC_TYPES.includes(e.type) && rel.nav) {
      const toArrow = navAt(atTo);
      const fromArrow = navAt(atFrom);
      if (rel.nav === 'to' && !toArrow && fromArrow) {
        local.error(where, `The arrowhead is at the wrong end. ${rel.from} holds the reference, so the arrow points at ${rel.to}.`, ref);
      } else if (rel.nav === 'from' && !fromArrow && toArrow) {
        local.error(where, `The arrowhead is at the wrong end. ${rel.to} holds the reference, so the arrow points at ${rel.from}.`, ref);
      } else {
        if ((rel.nav === 'to' || rel.nav === 'both') && !toArrow) local.error(where, `Missing navigability: add an arrowhead at the ${rel.to} end (${rel.from} holds a reference to ${rel.to}).`, ref);
        if ((rel.nav === 'from' || rel.nav === 'both') && !fromArrow) local.error(where, `Missing navigability: add an arrowhead at the ${rel.from} end.`, ref);
        if (rel.nav === 'to' && fromArrow) local.error(where, `${rel.to} has no reference to ${rel.from}; remove the arrowhead at the ${rel.from} end.`, ref);
        if (rel.nav === 'from' && toArrow) local.error(where, `${rel.from} has no reference to ${rel.to}; remove the arrowhead at the ${rel.to} end.`, ref);
      }
    }

    const endVal = (field, end) => clean(e[end + field]);
    const checkEnd = (field, label, wantList, end, otherEnd, cls, norm, side) => {
      if (!wantList) return;
      const list = listOf(wantList).map(norm);
      const got = norm(endVal(field, end));
      const other = norm(endVal(field, otherEnd));
      if (!list.includes(got)) {
        const mk = findMistake(rel.mistakes, side + field, got, norm);
        if (mk) { reportMistake(local, where, mk, ref); return; }
      }
      if (!got) {
        if (list.includes('')) return;
        if (other && list.includes(other)) local.error(where, `The ${label} "${other}" is at the wrong end. Put it next to ${cls}.`, ref);
        else local.error(where, `Add the ${label} next to ${cls}: ${list.filter(Boolean).join(' or ')}.`, ref);
      } else if (!list.includes(got)) {
        local.error(where, `${label[0].toUpperCase() + label.slice(1)} next to ${cls} should be ${list.filter(Boolean).join(' or ')}${list.includes('') ? ' (or left blank)' : ''}, not "${got}".`, ref);
      }
    };
    if (ASSOC_TYPES.includes(e.type)) {
      checkEnd('Mult', 'multiplicity', rel.toMult, atTo, atFrom, rel.to, normMult, 'to');
      checkEnd('Mult', 'multiplicity', rel.fromMult, atFrom, atTo, rel.from, normMult, 'from');
      checkEnd('Role', 'role', rel.toRole, atTo, atFrom, rel.to, clean, 'to');
      checkEnd('Role', 'role', rel.fromRole, atFrom, atTo, rel.from, clean, 'from');
    } else if (['Mult', 'Role'].some((f) => clean(e['from' + f]) || clean(e['to' + f]))) {
      local.error(where, `Multiplicities and roles only go on associations, not on ${TYPE_WORD[e.type]}.`, ref);
    }
    return local.issues;
  }

  function gradeClassDiagram(key, diagram) {
    const r = makeReporter();
    const nodes = (diagram.nodes || []).map(normNode);
    const names = {};
    const byName = {};

    nodes.forEach((n) => {
      names[n.id] = n.name;
      if (n.kind === 'object') r.error(n.name || 'Box', `"${n.name}" is an object box. A class diagram shows classes only.`, { node: n.id });
      if (!n.name) { r.error('Box', 'A box has no name.', { node: n.id }); return; }
      if (byName[n.name]) r.error(n.name, `There are two boxes named ${n.name}. Draw each class once.`, { node: n.id });
      else byName[n.name] = n;
    });

    const edges = (diagram.edges || []).filter((e) => names[e.from] !== undefined && names[e.to] !== undefined);
    const used = new Set();
    const consumedAttrs = new Set(); // "Class.attr"

    // ---- relationships first (attributes may be consumed by them) ----
    for (const rel of key.relations || []) {
      const cands = edges.filter((e) => !used.has(e.id) && (
        (names[e.from] === rel.from && names[e.to] === rel.to) || (names[e.from] === rel.to && names[e.to] === rel.from)));
      const fromNode = byName[rel.from];
      const findAttr = (nm) => fromNode && fromNode.attrs.map(parseMember).find((m) => !m.isMethod && m.name === nm);

      // A two-way association may also be drawn as two one-way lines.
      const assocCands = cands.filter((e) => ASSOC_TYPES.includes(e.type));
      if (rel.orTwoLines && assocCands.length >= 2) {
        const sideOnly = (keep) => (rel.mistakes || []).filter((m) => m.type !== undefined || keep(m));
        const relA = Object.assign({}, rel, { nav: 'to', fromMult: undefined, fromRole: undefined,
          mistakes: sideOnly((m) => m.toMult !== undefined || m.toRole !== undefined) });
        const relB = Object.assign({}, rel, { from: rel.to, to: rel.from, nav: 'to', toMult: rel.fromMult, toRole: rel.fromRole, fromMult: undefined, fromRole: undefined,
          mistakes: sideOnly((m) => m.fromMult !== undefined || m.fromRole !== undefined).map((m) => Object.assign({}, m, { toMult: m.fromMult, toRole: m.fromRole, fromMult: undefined, fromRole: undefined })) });
        let best = null;
        for (const a of assocCands) for (const b of assocCands) {
          if (a === b) continue;
          const iss = evalEdge(relA, a, names).concat(evalEdge(relB, b, names));
          const score = iss.reduce((s, i) => s + costOf(i), 0);
          if (!best || score < best.score) best = { a, b, iss, score };
        }
        used.add(best.a.id); used.add(best.b.id);
        best.iss.forEach((i) => r.issues.push(i));
        r.note(relDesc(rel), rel.twoLinesNote || `Two one-way lines are accepted. ${rel.from} and ${rel.to} refer to each other, so the usual form is one line with arrowheads at both ends.`, { edge: best.a.id });
        continue;
      }

      if (!cands.length) {
        if (rel.orAttribute) {
          const a = findAttr(rel.orAttribute.name);
          if (a) {
            consumedAttrs.add(rel.from + '.' + a.name);
            r.note(relDesc(rel), rel.orAttribute.note || `Shown as attribute "${a.raw}" instead of a line. Usually accepted, but the question asks for associations as lines.`, { node: fromNode.id });
            checkAttr(r, rel.from, rel.orAttribute, a, { node: fromNode.id });
            continue;
          }
        }
        const roleAttr = listOf(rel.toRole) && listOf(rel.toRole).map((x) => findAttr(x)).find(Boolean);
        if (roleAttr && ASSOC_TYPES.includes(rel.type)) {
          consumedAttrs.add(rel.from + '.' + roleAttr.name);
          r.error(relDesc(rel), `"${roleAttr.raw}" is a reference to ${rel.to}. Draw it as an association line from ${rel.from} to ${rel.to} (role ${roleAttr.name}), not as an attribute.`, { node: fromNode.id });
          continue;
        }
        if (!rel.optional && byName[rel.from] && byName[rel.to]) {
          r.error(relDesc(rel), `Missing ${TYPE_WORD[rel.type]} from ${rel.from} to ${rel.to}.${rel.missingHint ? ' ' + rel.missingHint : ''}`);
        }
        continue;
      }
      let best = null;
      for (const e of cands) {
        const iss = evalEdge(rel, e, names);
        const score = iss.reduce((s, i) => s + costOf(i), 0);
        if (!best || score < best.score) best = { e, iss, score };
      }
      used.add(best.e.id);
      best.iss.forEach((i) => r.issues.push(i));
      if (rel.optional && best.score === 0 && rel.optionalNote) r.note(relDesc(rel), rel.optionalNote, { edge: best.e.id });
    }

    for (const e of edges) {
      if (used.has(e.id)) continue;
      const a = names[e.from], b = names[e.to];
      r.error(`${a} – ${b}`, `Unexpected ${TYPE_WORD[e.type] || e.type} between ${a} and ${b}. The code has no such relationship.`, { edge: e.id });
    }

    // Role names drawn on lines, per class (the class that holds the reference)
    const roleNames = {};
    const addRole = (cls, role) => { if (!role) return; (roleNames[cls] = roleNames[cls] || new Set()).add(role); };
    for (const e of edges) {
      if (!ASSOC_TYPES.includes(e.type)) continue;
      addRole(names[e.from], clean(e.toRole));
      addRole(names[e.to], clean(e.fromRole));
    }
    for (const rel of key.relations || []) {
      (listOf(rel.toRole) || []).forEach((x) => addRole(rel.from, x));
      (listOf(rel.fromRole) || []).forEach((x) => addRole(rel.to, x));
    }

    // ---- classes ----
    const classes = key.classes || {};
    for (const [cls, spec] of Object.entries(classes)) {
      let n = byName[cls];
      if (!n) {
        const near = nodes.find((x) => x.name.toLowerCase() === cls.toLowerCase());
        if (near) { r.error(cls, `Class name should be spelled ${cls}, not ${near.name}.`, { node: near.id }); n = near; }
        else { r.error(cls, `Missing class ${cls}.`); continue; }
      }
      const ref = { node: n.id };
      const want = spec.stereo || '';
      if (n.stereo !== want) r.error(cls, STEREO_FIX[want] || `Stereotype should be ${want}.`, ref);

      if (want === 'enumeration') {
        const vals = n.attrs.map((a) => clean(a).replace(/[,;]$/, ''));
        const expected = spec.values || [];
        expected.filter((v) => !vals.includes(v)).forEach((v) => r.error(cls, `Missing enum value ${v}.`, ref));
        vals.filter((v) => !expected.includes(v)).forEach((v) => {
          const bare = parseMember(v).name;
          if (expected.includes(bare)) r.error(cls, `Enum values are written plainly ("${bare}"), without visibility or type.`, ref);
          else r.error(cls, `Unexpected enum value "${v}".`, ref);
        });
        if (n.methods.length) r.error(cls, 'This enumeration has no methods in the code; remove them.', ref);
        continue;
      }

      // attributes
      const attrs = n.attrs.map(parseMember);
      const wantAttrs = spec.attrs || [];
      const optAttrs = spec.optionalAttrs || [];
      const matched = new Set();
      for (const a of attrs) {
        if (a.isMethod) { r.error(cls, `"${a.raw}" is a method; move it to the methods (bottom) compartment.`, ref); matched.add(a); continue; }
        if (consumedAttrs.has(cls + '.' + a.name)) { matched.add(a); continue; }
        const s = wantAttrs.find((x) => x.name === a.name) || optAttrs.find((x) => x.name === a.name);
        if (s) { matched.add(a); checkAttr(r, cls, s, a, ref); continue; }
        if (roleNames[cls] && roleNames[cls].has(a.name)) {
          matched.add(a);
          r.error(cls, `"${a.raw}" is already shown as an association (role "${a.name}"). Show it once: as the line, not also as an attribute.`, ref);
        }
      }
      for (const s of wantAttrs) {
        if (!attrs.some((a) => !a.isMethod && a.name === s.name)) r.error(cls, `Missing attribute ${s.vis || ''}${s.name}: ${listOf(s.type)[0]}.`, ref);
      }
      attrs.filter((a) => !matched.has(a)).forEach((a) => r.error(cls, `Unexpected attribute "${a.raw}".`, ref));

      // methods
      const methods = n.methods.map(parseMember);
      const wantM = spec.methods || [];
      const optM = spec.optionalMethods || [];
      const usedM = new Set();
      const pick = (s) => {
        const same = methods.filter((m) => m.isMethod && !usedM.has(m) && m.name === s.name);
        if (!same.length) return null;
        const exact = same.find((m) => (m.params || []).length === (s.params || []).length);
        return exact || same[0];
      };
      for (const s of wantM) {
        const m = pick(s);
        if (!m) { r.error(cls, `Missing method ${sigOf({ vis: s.vis, name: s.name, params: s.params || [] })}.`, ref); continue; }
        usedM.add(m);
        checkMethod(r, cls, n.stereo, s, m, ref);
      }
      for (const s of optM) {
        const m = pick(s);
        if (!m) continue;
        usedM.add(m);
        checkMethod(r, cls, n.stereo, s, m, ref);
      }
      for (const m of methods) {
        if (usedM.has(m)) continue;
        if (!m.isMethod) r.error(cls, `"${m.raw}" looks like an attribute; move it to the attributes (middle) compartment.`, ref);
        else r.error(cls, `Unexpected method "${m.raw}".`, ref);
      }
    }

    for (const n of nodes) {
      if (!n.name || classes[n.name] || n.kind === 'object') continue;
      if (Object.keys(classes).some((c) => c.toLowerCase() === n.name.toLowerCase())) continue;
      const hint = (key.extraClassHints || {})[n.name];
      r.error(n.name, hint || `Unexpected class ${n.name}. It is not part of the code (library types like String or List are not drawn as boxes).`, { node: n.id });
    }
    return r.issues;
  }

  // ---------- object diagrams ----------

  function gradeObjectDiagram(key, diagram) {
    const r = makeReporter();
    const nodes = (diagram.nodes || []).map(normNode);
    const ids = {};
    nodes.forEach((n) => { ids[n.id] = n; });

    nodes.forEach((n) => {
      if (n.kind !== 'object') r.error(n.name || 'Box', `"${n.name}" is a class box. Object diagrams show objects, written name:Class and underlined.`, { node: n.id });
      else if (!n.hasColon || !n.className) r.error(n.name || 'Object', `Write the object as name:Class or :Class (got "${n.name}").`, { node: n.id });
      if (n.methods.length) r.error(n.name, 'Objects do not show methods. Remove the methods compartment.', { node: n.id });
    });

    // A class box drawn by mistake still stands in for its object, so one mistake counts once.
    nodes.forEach((n) => { if (n.kind !== 'object') { n.className = n.name; n.objName = ''; } });
    const objects = nodes;
    const assigned = {}; // ref -> node
    const taken = new Set();

    for (const spec of key.objects || []) {
      let n = objects.find((o) => !taken.has(o.id) && listOf(spec.class).includes(o.className));
      if (!n && spec.wrongClass) {
        const w = objects.find((o) => !taken.has(o.id) && spec.wrongClass[o.className]);
        if (w) { r.error(w.name, spec.wrongClass[w.className], { node: w.id }); n = w; }
      }
      if (!n) { r.error(listOf(spec.class)[0], `Missing object :${listOf(spec.class)[0]}.${spec.missingHint ? ' ' + spec.missingHint : ''}`); continue; }
      taken.add(n.id);
      assigned[spec.ref] = n;
    }

    const linked = (a, b) => (diagram.edges || []).filter((e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
    const extraOk = new Set(); // node ids accepted as alternatives
    const edgeOk = new Set();

    for (const spec of key.objects || []) {
      const n = assigned[spec.ref];
      if (!n) continue;
      const ref = { node: n.id };
      const attrs = n.attrs.map(parseMember);
      const seen = new Set();
      for (const s of spec.attrs || []) {
        const a = attrs.find((x) => x.name === s.name);
        if (!a) {
          if (s.orLinkedObject) {
            const alt = objects.find((o) => !taken.has(o.id) && o.className === s.orLinkedObject.class);
            if (alt) {
              extraOk.add(alt.id);
              const lk = linked(n, alt);
              lk.forEach((e) => edgeOk.add(e.id));
              if (!lk.length) r.error(alt.name, `Link ${alt.name} to ${n.name}, or show it as the attribute ${s.name} = ${s.value[0]} instead.`, { node: alt.id });
              if (!listOf(s.orLinkedObject.name).includes(alt.objName)) r.error(alt.name, `Name the object after the value it represents: ${listOf(s.orLinkedObject.name)[0]}:${alt.className}.`, { node: alt.id });
              r.note(n.name, `Showing ${s.name} as a linked ${alt.className} object is accepted. The attribute form ${s.name} = ${s.value[0]} is also fine.`, ref);
              continue;
            }
          }
          r.error(n.name, `Show the attribute value: ${s.name} = ${s.value[0]}.`, ref);
          continue;
        }
        seen.add(a);
        if (a.value == null) r.error(n.name, `"${a.raw}": object attributes show a value, e.g. ${s.name} = ${s.value[0]}.`, ref);
        else if (!listOf(s.value).map(unquote).includes(unquote(a.value).replace(/^\w+\./, ''))) r.error(n.name, `"${a.raw}": value should be ${s.value[0]}.`, ref);
        if (a.vis) r.note(n.name, `"${a.raw}": visibility is not needed in an object diagram.`, ref);
      }
      for (const a of attrs) {
        if (seen.has(a)) continue;
        const why = (spec.forbidAttrs || {})[a.name];
        if (why) r.error(n.name, why, ref);
        else r.note(n.name, `"${a.raw}" is not needed for this situation.`, ref);
      }
    }

    for (const o of objects) {
      if (taken.has(o.id) || extraOk.has(o.id)) continue;
      const hint = (key.extraObjectHints || {})[o.className];
      r.error(o.name, hint || `Unexpected object ${o.name}. Each real object appears once.`, { node: o.id });
    }

    for (const l of key.links || []) {
      const a = assigned[l.a], b = assigned[l.b];
      if (!a || !b) continue;
      const lk = linked(a, b);
      if (!lk.length) { r.error(`${a.name} – ${b.name}`, `Missing link between ${a.name} and ${b.name}.`); continue; }
      lk.forEach((e, i) => {
        edgeOk.add(e.id);
        const ref = { edge: e.id };
        const where = `${a.name} – ${b.name}`;
        if (i > 0) r.error(where, 'Duplicate link; one line is enough.', ref);
        if (!['link', 'association'].includes(e.type)) r.error(where, `Objects are connected with plain lines (links), not ${TYPE_WORD[e.type]}.`, ref);
        if (clean(e.fromMult) || clean(e.toMult)) r.error(where, 'Links in object diagrams have no multiplicities (each line joins exactly one object to one object).', ref);
        if (e.navTo || e.navFrom) r.note(where, 'Arrowheads are not needed on object links; a plain line is the usual form.', ref);
      });
    }
    const extraObj = (o) => !taken.has(o.id) && !extraOk.has(o.id);
    for (const e of diagram.edges || []) {
      if (edgeOk.has(e.id)) continue;
      const a = ids[e.from], b = ids[e.to];
      if (!a || !b) continue;
      if (extraObj(a) || extraObj(b)) continue; // the extra object is already an error; its links are part of it
      r.error(`${a.name} – ${b.name}`, `Unexpected link between ${a.name} and ${b.name}.`, { edge: e.id });
    }
    return r.issues;
  }

  // ---------- sequence diagrams ----------
  //
  // Stored diagram: { lifelines: [{ id, name, kind: 'object'|'class'|'actor' }],
  //                   rows: [{ id, type, ... }] }   (rows are in top-to-bottom order)
  // Row types: call | return | create | delete  { from, to, label }
  //            frame { frame: 'loop'|'alt'|'opt'|'par', guard } | else { guard } | end
  // from may be '@start' (a call coming in from outside the diagram).

  const START = '@start';
  const FRAME_TYPES = ['loop', 'alt', 'opt', 'par'];

  /** "lend(title, m)" -> { name: 'lend', args: ['title','m'], hasParens: true }; also accepts "b = find(t)". */
  function parseCall(label) {
    let s = clean(label);
    const eq = s.match(/^[\w.]+\s*=\s*(.+)$/);
    if (eq && eq[1].includes('(')) s = eq[1];
    s = s.replace(/^new\s+/, '');
    const i = s.indexOf('(');
    if (i < 0) return { name: s, args: [], hasParens: false };
    const close = s.lastIndexOf(')');
    const inner = s.slice(i + 1, close > i ? close : s.length);
    return { name: clean(s.slice(0, i)).replace(/^.*\./, ''), args: splitParams(inner), hasParens: true };
  }

  /** Lifeline header -> { objName, className, isStatic, hasColon } */
  function parseLifeline(l) {
    let s = clean(l.name);
    let isStatic = l.kind === 'class';
    s = s.replace(/<<\s*class\s*>>|«\s*class\s*»/gi, () => { isStatic = true; return ' '; });
    s = clean(s);
    const i = s.indexOf(':');
    if (i >= 0) return { objName: clean(s.slice(0, i)), className: clean(s.slice(i + 1)), isStatic, hasColon: true, kind: l.kind };
    return { objName: '', className: s, isStatic, hasColon: false, kind: l.kind };
  }

  /**
   * Turn rows into a call tree. Missing return arrows are allowed (minimal notation):
   * a message sent by X ends any newer activations above X's.
   * Returns { root, problems, acts, frames } — acts/frames carry row indexes for drawing.
   */
  function buildSeqTree(d) {
    const rows = d.rows || [];
    const lifes = {};
    (d.lifelines || []).forEach((l) => { lifes[l.id] = l; });
    const isOutside = (id) => id === START || (lifes[id] && lifes[id].kind === 'actor');
    const nm = (id) => (id === START ? 'the caller' : lifes[id] ? clean(lifes[id].name) || '(unnamed)' : '?');

    const problems = [];
    const acts = [];
    const frames = [];
    const root = { kind: 'root', children: [] };
    const stack = [{ t: 'act', node: root, who: null, info: null }];
    const list = () => { const e = stack[stack.length - 1]; return e.t === 'act' ? e.node.children : e.node.branches[e.node.branches.length - 1].children; };
    const findAct = (who) => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].t === 'act' && stack[i].who === who) return i; return -1; };
    const findFrame = () => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].t === 'frame') return i; return -1; };
    const framesAbove = (idx) => stack.slice(idx + 1).filter((e) => e.t === 'frame');
    const popTo = (idx, k, viaReturn) => {
      while (stack.length - 1 > idx) {
        const e = stack.pop();
        if (e.t === 'act' && e.info) e.info.end = viaReturn && stack.length === idx + 1 ? k : k - 0.5;
        if (e.t === 'frame') e.info.end = k - 0.5;
      }
    };
    const depthOf = (who) => stack.filter((e) => e.t === 'act' && e.who === who).length;
    // A frame belongs to whoever sends the first message inside it, so it is opened lazily:
    // without return arrows, "frame" may come right after a call whose activation is about to end.
    let pending = [];
    const openPending = () => {
      for (const { row, k } of pending) {
        const node = { kind: 'frame', frame: row.frame, row: row.id, branches: [{ guard: clean(row.guard), row: row.id, children: [] }] };
        list().push(node);
        const info = { start: k, end: rows.length - 0.5, elses: [], depth: stack.filter((e) => e.t === 'frame').length, frame: row.frame, row: row.id, guard: clean(row.guard) };
        frames.push(info);
        stack.push({ t: 'frame', node, info });
      }
      pending = [];
    };

    rows.forEach((row, k) => {
      const ref = { row: row.id };
      if (row.type === 'call' || row.type === 'create' || row.type === 'delete') {
        let idx = isOutside(row.from) ? 0 : findAct(row.from);
        if (idx < 0) {
          if (stack.length === 1 && !root.children.length) {
            // diagram starts without an incoming call: treat the first sender as already running
            stack.push({ t: 'act', node: root, who: row.from, info: null });
            idx = 1;
          } else {
            problems.push({ sev: 'error', where: nm(row.from), msg: `${nm(row.from)} sends "${clean(row.label) || row.type}" but has no running method at that point. Messages must come from an active lifeline.`, ref });
            idx = stack.length - 1;
          }
        }
        // end newer activations (implicit returns); a frame opened inside one of them cannot stay open
        while (stack.length - 1 > idx) {
          const e = stack[stack.length - 1];
          if (e.t === 'act') { stack.pop(); if (e.info) e.info.end = k - 0.5; continue; }
          if (!stack.slice(idx + 1, stack.length - 1).some((x) => x.t === 'act')) break;
          problems.push({ sev: 'error', where: nm(row.from), msg: `"${clean(row.label) || row.type}" is sent by ${nm(row.from)}, but the ${e.node.frame} frame opened inside a later call is still open. End that frame first.`, ref });
          stack.pop(); e.info.end = k - 0.5;
        }
        openPending();
        const node = { kind: row.type, from: row.from, to: row.to, label: clean(row.label), row: row.id, children: [], ret: null };
        list().push(node);
        if (row.type !== 'delete') {
          const info = { who: row.to, start: k, end: rows.length - 0.5, depth: depthOf(row.to), row: row.id };
          acts.push(info);
          stack.push({ t: 'act', node, who: row.to, info });
        }
      } else if (row.type === 'return') {
        openPending();
        const idx = findAct(row.from);
        if (idx < 0) { problems.push({ sev: 'error', where: nm(row.from), msg: `Return from ${nm(row.from)}, but it has no running method to return from.`, ref }); return; }
        const crossing = framesAbove(idx);
        if (crossing.length) problems.push({ sev: 'error', where: nm(row.from), msg: `This return leaves an open ${crossing[crossing.length - 1].node.frame} frame. End the frame before returning.`, ref });
        let below = idx - 1;
        while (below > 0 && stack[below].t !== 'act') below--;
        const caller = stack[below].who;
        const ok = caller === null ? isOutside(row.to) || row.to === row.from : row.to === caller;
        if (!ok) problems.push({ sev: 'error', where: nm(row.from), msg: `The return should go back to ${caller === null ? 'the caller' : nm(caller)}, which made the call.`, ref });
        stack[idx].node.ret = { label: clean(row.label), row: row.id };
        popTo(idx - 1, k, true);
      } else if (row.type === 'frame') {
        pending.push({ row, k });
      } else if (row.type === 'else' || row.type === 'end') {
        openPending();
        const idx = findFrame();
        if (idx < 0) { problems.push({ sev: 'error', where: 'Frame', msg: row.type === 'else' ? 'An else divider sits outside any frame.' : 'A frame end has no matching frame start.', ref }); return; }
        popTo(idx, k, false);
        const f = stack[idx];
        if (row.type === 'else') {
          if (!['alt', 'par'].includes(f.node.frame)) problems.push({ sev: 'error', where: f.node.frame, msg: `Only alt and par frames are split into parts; a ${f.node.frame} frame has one part.`, ref });
          f.node.branches.push({ guard: clean(row.guard), row: row.id, children: [] });
          f.info.elses.push({ at: k, guard: clean(row.guard), row: row.id });
        } else {
          f.info.end = k;
          stack.splice(idx, 1);
        }
      }
    });
    openPending();
    stack.filter((e) => e.t === 'frame').forEach((e) => problems.push({ sev: 'error', where: e.node.frame, msg: `The ${e.node.frame} frame is never closed. Add a frame end.`, ref: { row: e.node.row } }));
    return { root, problems, acts, frames };
  }

  function gradeSequenceDiagram(key, diagram) {
    const r = makeReporter();
    const d = { lifelines: diagram.lifelines || [], rows: diagram.rows || [] };
    const tree = buildSeqTree(d);
    tree.problems.forEach((p) => r.issues.push(p));

    // ---- map lifelines to key refs ----
    const parsed = {};
    d.lifelines.forEach((l) => { parsed[l.id] = parseLifeline(l); });
    const refOf = {};       // lifeline id -> key ref
    const lifeOf = {};      // key ref -> lifeline id
    const missingRefs = new Set();
    const extraLifes = new Set();
    const keyL = key.lifelines || [];
    for (const kl of keyL) {
      const hit = d.lifelines.find((l) => !refOf[l.id] && l.kind !== 'actor' && parsed[l.id].className === kl.class);
      if (!hit) { r.error(`:${kl.class}`, `Missing lifeline for ${kl.static ? 'the class ' + kl.class : 'a ' + kl.class + ' object'}.`); missingRefs.add(kl.ref); continue; }
      refOf[hit.id] = kl.ref; lifeOf[kl.ref] = hit.id;
      const p = parsed[hit.id];
      const ref = { lifeline: hit.id };
      if (kl.static && !p.isStatic) r.error(`:${kl.class}`, `${kl.class}.${kl.staticHint || 'method'}() is a static call. Draw ${kl.class} as a class lifeline: <<class>> ${kl.class}, with no colon.`, ref);
      if (!kl.static && p.isStatic) r.error(`:${kl.class}`, `${kl.class} is an object here, not a class. Write it as :${kl.class} or name:${kl.class}.`, ref);
      if (!kl.static && !p.isStatic && !p.hasColon) r.error(`${p.className}`, `Object lifelines are written :${kl.class} or name:${kl.class}.`, ref);
    }
    d.lifelines.forEach((l) => {
      if (refOf[l.id] || l.kind === 'actor') return;
      extraLifes.add(l.id);
      r.error(clean(l.name) || 'Lifeline', `Unexpected lifeline ${clean(l.name)}. Nothing in the code calls it.`, { lifeline: l.id });
    });
    const createdRefs = new Set(keyL.filter((k) => k.created).map((k) => k.ref));
    const lname = (ref) => { const kl = keyL.find((k) => k.ref === ref); return kl ? (kl.static ? kl.class : ':' + kl.class) : ref; };

    // ---- compare trees ----
    const expKey = (e) => e.frame ? 'frame:' + e.frame : (e.create ? 'create:' + e.create : 'call:' + e.call + ':' + e.method);
    const actKey = (a) => {
      if (a.kind === 'frame') return 'frame:' + a.frame;
      const t = refOf[a.to] || '?' + a.to;
      if (a.kind === 'create') return 'create:' + t;
      if (a.kind === 'delete') return 'delete:' + t;
      return 'call:' + t + ':' + parseCall(a.label).name;
    };
    const descE = (e) => e.frame ? `the ${e.frame} frame` : e.create ? `the creation of ${lname(e.create)}` : `${e.method}() on ${lname(e.call)}`;
    const descA = (a) => a.kind === 'frame' ? `${a.frame} frame` : a.kind === 'create' ? `creation of ${clean((d.lifelines.find((l) => l.id === a.to) || {}).name)}` : `"${a.label || '(no label)'}"`;
    const firstRow = (a) => (a.kind === 'frame' ? { row: a.row } : { row: a.row });
    const looseOK = (e, a) => {
      if (e.frame) return a.kind === 'frame';
      if (a.kind === 'frame') return false;
      const target = e.create || e.call;
      return refOf[a.to] === target || (a.kind === e.create ? 'create' : 'call') === a.kind;
    };

    const missing = [];   // { e, ctx }
    const unexpected = []; // { a, ctx }

    function lcs(E, A) {
      const n = E.length, m = A.length;
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = expKey(E[i]) === actKey(A[j]) ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const pairs = [];
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (expKey(E[i]) === actKey(A[j])) { pairs.push([i, j]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
      }
      return pairs;
    }

    function compareList(E, A, ctx, parent) {
      E = E.filter((e) => !(e.call && missingRefs.has(e.call)) && !(e.create && missingRefs.has(e.create)));
      A = A.filter((a) => a.kind === 'frame' || !extraLifes.has(a.to));
      const pairs = lcs(E, A);
      let pi = 0, pj = 0;
      const segs = pairs.concat([[E.length, A.length]]);
      for (const [mi, mj] of segs) {
        const gapE = E.slice(pi, mi), gapA = A.slice(pj, mj);
        // pair loosely-compatible items in the same gap, in order
        const usedA = new Set();
        const doneE = new Set();
        // known mistake first: the right method sent to a lifeline the key names in "mistakes"
        for (const e of gapE) {
          if (!e.call || !e.mistakes) continue;
          const x = gapA.find((y) => !usedA.has(y) && y.kind === 'call' && parseCall(y.label).name === e.method && findMistake(e.mistakes, 'to', refOf[y.to] || ''));
          if (!x) continue;
          usedA.add(x); doneE.add(e);
          reportMistake(r, ctx, findMistake(e.mistakes, 'to', refOf[x.to]), firstRow(x));
          compareList(e.body || [], x.children || [], `inside ${e.method}()`, x);
        }
        for (const e of gapE) {
          if (doneE.has(e)) continue;
          // a switch or if/else drawn as several opt frames in a row: one mistake, then grade as the alt
          if (e.frame === 'alt') {
            const i0 = gapA.findIndex((x) => !usedA.has(x) && x.kind === 'frame' && x.frame === 'opt');
            const run = [];
            for (let i = i0; i0 >= 0 && i < gapA.length && gapA[i].kind === 'frame' && gapA[i].frame === 'opt' && !usedA.has(gapA[i]); i++) run.push(gapA[i]);
            if (run.length >= 2) {
              run.forEach((x) => usedA.add(x));
              const merged = { kind: 'frame', frame: 'alt', merged: true, row: run[0].row, branches: run.flatMap((x) => x.branches) };
              const mk = findMistake(e.mistakes, 'frame', 'opt');
              if (mk) reportMistake(r, ctx, mk, { row: run[0].row });
              else r.error(ctx, `These ${run.length} opt frames are the cases of one choice, and only one of them can run. Draw one alt frame with a part for each case.`, { row: run[0].row });
              compareItem(e, merged, ctx, true);
              continue;
            }
          }
          const a = gapA.find((x) => !usedA.has(x) && looseOK(e, x) && (e.frame || refOf[x.to] === (e.create || e.call)));
          if (a) { usedA.add(a); compareItem(e, a, ctx, true); }
          else missing.push({ e, ctx });
        }
        gapA.filter((a) => !usedA.has(a)).forEach((a) => unexpected.push({ a, ctx, parent }));
        if (mi < E.length) compareItem(E[mi], A[mj], ctx, false);
        pi = mi + 1; pj = mj + 1;
      }
    }

    function compareItem(e, a, ctx, loose) {
      const ref = firstRow(a);
      if (e.frame) {
        if (a.frame !== e.frame && !(e.accept || []).includes(a.frame)) {
          const mk = findMistake(e.mistakes, 'frame', a.frame);
          if (mk) reportMistake(r, ctx, mk, ref);
          else r.error(ctx, `Use a ${e.frame} frame here, not ${a.frame}. ${e.hint || FRAME_HINT[e.frame]}`, ref);
        }
        const eb = e.branches || [{ body: e.body || [] }];
        // branches marked optional (an empty [else], say) may be left out; they must come last
        const minB = eb.filter((b) => !b.optional).length;
        const nA = a.branches.length;
        if (a.frame === e.frame && (nA < minB || nA > eb.length)) r.error(ctx, `The ${e.frame} frame should have ${minB}${eb.length > minB ? ' or ' + eb.length : ''} part${eb.length === 1 ? '' : 's'}${e.frame === 'alt' ? ' (one per branch of the if/else or switch)' : ''}, not ${nA}.`, ref);
        a.branches.forEach((b, bi) => { if (!b.guard) r.error(ctx, `Add a guard condition in square brackets to ${a.branches.length > 1 ? 'part ' + (bi + 1) + ' of ' : ''}the ${a.frame} frame, e.g. ${(eb[bi] && eb[bi].guardExample) || (e.frame === 'loop' ? '[for each item]' : '[else]')}.`, { row: b.row }); });
        if (a.frame !== e.frame && eb.length > 1) {
          // wrong kind of frame: its parts can't line up with the key's, so compare the calls inside as a whole
          compareList(eb.flatMap((b) => b.body || []), a.branches.flatMap((b) => b.children), `inside the ${e.frame} frame`);
          return;
        }
        eb.forEach((b, bi) => {
          const ab = a.branches[bi];
          compareList(b.body || [], ab ? ab.children : [], `inside the ${e.frame} frame${eb.length > 1 ? ' (part ' + (bi + 1) + ')' : ''}`);
        });
        // extra branches: their contents are unexpected
        a.branches.slice(eb.length).forEach((b) => b.children.forEach((c) => unexpected.push({ a: c, ctx })));
        return;
      }
      const target = e.create || e.call;
      if (refOf[a.to] !== target) {
        r.error(ctx, `${descA(a)} goes to the wrong lifeline; ${descE(e)} is expected here.`, ref);
      }
      if (e.create && a.kind !== 'create') r.error(ctx, `${lname(e.create)} is created here. Point the arrow at the ${lname(e.create)} box and place the box at this height (use the Create message).`, ref);
      if (e.call && a.kind === 'create') r.error(ctx, `${lname(e.call)} already exists; this is a normal call, not a creation.`, ref);
      if (a.kind === 'delete') r.error(ctx, `${descE(e)} is expected here, not a deletion.`, ref);
      let skipBody = false;
      if (e.call && a.kind === 'call') {
        const pc = parseCall(a.label);
        const mk = pc.name !== e.method && findMistake(e.mistakes, 'method', pc.name);
        // a known wrong method explains the whole call, so its missing inner calls are not counted again
        if (mk) { reportMistake(r, ctx, mk, ref); skipBody = true; }
        else if (pc.name !== e.method) r.error(ctx, `"${a.label}" should call ${e.method}().`, ref);
        else if (!pc.hasParens) r.error(ctx, `Write the call with brackets: ${e.method}(${'…'.repeat(Math.min(1, e.args || 0))}).`, ref);
        else if (e.args !== undefined && pc.args.length !== e.args) r.error(ctx, `"${a.label}" should pass ${e.args} argument${e.args === 1 ? '' : 's'}.`, ref);
      }
      if (e.create && a.kind === 'create' && a.label) {
        const pc = parseCall(a.label);
        if (pc.hasParens && e.args !== undefined && pc.args.length !== e.args) r.note(ctx, `"${a.label}": the constructor takes ${e.args} argument${e.args === 1 ? '' : 's'}.`, ref);
      }
      // return value
      if (e.returns) {
        if (!a.ret) r.note(ctx, `${descE(e)} returns ${e.returns}. A dashed return arrow labelled ${e.returns} makes that clear (it may be left out in minimal notation).`, ref);
        else if (!a.ret.label) r.note(ctx, `Label the return arrow of ${e.method || 'the call'}() with the value, e.g. ${e.returns}.`, { row: a.ret.row });
      } else if (a.ret && a.ret.label && !e.create) {
        r.error(ctx, `${e.method}() returns nothing, so its return arrow has no value. Remove "${a.ret.label}" or the arrow.`, { row: a.ret.row });
      }
      if (e.create && a.kind === 'create' && !createdRefs.has(e.create)) r.error(ctx, `${lname(e.create)} is not created in this scenario.`, ref);
      if (!skipBody) compareList(e.body || [], a.children || [], `inside ${e.create ? 'the ' + lname(e.create) + ' constructor' : e.method + '()'}`, a);
    }

    // entry call
    const ent = key.entry;
    const top = tree.root.children;
    const entryIdx = top.findIndex((a) => a.kind === 'call' && refOf[a.to] === ent.to && parseCall(a.label).name === ent.method);
    let body;
    if (entryIdx < 0) {
      r.error('Start', `Show the incoming call ${ent.method}(…) arriving at ${lname(ent.to)} from the left (use the Call tool from the start dot).`);
      body = top;
    } else {
      const a = top[entryIdx];
      const ref = { row: a.row };
      if (!(a.from === START || (d.lifelines.find((l) => l.id === a.from) || {}).kind === 'actor')) r.error('Start', `The first call ${ent.method}() comes from outside the diagram. Start it from the start dot (or an actor).`, ref);
      const pc = parseCall(a.label);
      if (!pc.hasParens) r.error('Start', `Write the call with brackets: ${ent.method}(…).`, ref);
      else if (ent.args !== undefined && pc.args.length !== ent.args) r.error('Start', `"${a.label}" should pass ${ent.args} argument${ent.args === 1 ? '' : 's'}.`, ref);
      if (ent.returns && (!a.ret || !a.ret.label)) r.note('Start', `${ent.method}() returns ${ent.returns}. Show a dashed return arrow labelled ${ent.returns} back to the caller.`, ref);
      top.forEach((x, i) => { if (i !== entryIdx) unexpected.push({ a: x, ctx: 'outside the ' + ent.method + '() call' }); });
      body = a.children;
    }
    compareList(key.body || [], body, `inside ${ent.method}()`);

    // a missing frame whose calls are drawn without it -> one error
    for (const m of missing) {
      if (!m.e.frame) continue;
      const inner = (m.e.branches || [{ body: m.e.body || [] }]).flatMap((b) => b.body || []).map(expKey);
      const hits = unexpected.filter((u) => !u.done && u.ctx === m.ctx && inner.includes(actKey(u.a)));
      if (!hits.length) continue;
      hits.forEach((u) => { u.done = true; });
      m.done = true;
      r.error(m.ctx, `Missing the ${m.e.frame} frame around ${hits.map((u) => descA(u.a)).join(', ')}. ${m.e.hint || FRAME_HINT[m.e.frame]}`, firstRow(hits[0].a));
    }
    // a known mistake: the right method sent to the wrong lifeline -> one error with the key's message
    for (const m of missing) {
      if (m.done || !m.e.call || !m.e.mistakes) continue;
      const u = unexpected.find((x) => !x.done && x.ctx === m.ctx && x.a.kind === 'call'
        && parseCall(x.a.label).name === m.e.method && findMistake(m.e.mistakes, 'to', refOf[x.a.to] || ''));
      if (!u) continue;
      u.done = true; m.done = true;
      reportMistake(r, m.ctx, findMistake(m.e.mistakes, 'to', refOf[u.a.to]), firstRow(u.a));
    }
    // pair "missing here" with "unexpected there" -> one "wrong place" error
    for (const m of missing) {
      if (m.done) continue;
      const k = expKey(m.e);
      const u = unexpected.find((x) => !x.done && actKey(x.a) === k);
      if (u) {
        u.done = true; m.done = true;
        const pa = u.parent;
        const selfHint = pa && pa.kind === 'call' && pa.from === pa.to && !pa.ret ? ` The self-call ${parseCall(pa.label).name}() has no return arrow, so later messages from that lifeline stay inside it. Add a return to end it.` : '';
        r.error(u.ctx, `${descE(m.e)} is in the wrong place. It should happen ${m.ctx}, but it is drawn ${u.ctx}.${selfHint}`, firstRow(u.a));
      }
    }
    missing.filter((m) => !m.done).forEach((m) => r.error(m.ctx, `Missing ${descE(m.e)} ${m.ctx}.${m.e.hint ? ' ' + m.e.hint : ''}`));
    unexpected.filter((u) => !u.done).forEach((u) => {
      const a = u.a;
      if (a.kind === 'frame' && !a.branches.some((b) => b.children.length)) r.error(u.ctx, `This ${a.frame} frame has no messages inside. Frames only wrap calls; remove it.`, firstRow(a));
      else r.error(u.ctx, `Unexpected ${descA(a)} ${u.ctx}. The code does not do this here.`, firstRow(a));
    });
    return r.issues;
  }

  const FRAME_HINT = {
    loop: 'Repeated calls (for/while) go in a loop frame.',
    alt: 'An if/else with calls in both branches is an alt frame.',
    opt: 'An if with no else is an opt frame.',
    par: 'Calls that run in parallel go in a par frame.',
  };

  function seqToText(d) {
    const nm = {};
    (d.lifelines || []).forEach((l) => { nm[l.id] = `${l.kind === 'class' ? '<<class>> ' : ''}${clean(l.name)}${l.kind === 'actor' ? ' (actor)' : ''}`; });
    nm[START] = '(caller)';
    const lines = ['lifelines: ' + (d.lifelines || []).map((l) => nm[l.id]).join(', ')];
    let depth = 0;
    for (const row of d.rows || []) {
      if (row.type === 'end' || row.type === 'else') depth = Math.max(0, depth - 1);
      const pad = '  '.repeat(depth);
      if (row.type === 'frame') { lines.push(`${pad}${row.frame} [${clean(row.guard)}]`); depth++; }
      else if (row.type === 'else') { lines.push(`${pad}else [${clean(row.guard)}]`); depth++; }
      else if (row.type === 'end') lines.push(`${pad}end`);
      else lines.push(`${pad}${row.type}: ${nm[row.from] || row.from} -> ${nm[row.to] || row.to}${row.label ? ' : ' + clean(row.label) : ''}`);
    }
    return lines.join('\n');
  }

  // ---------- activity diagrams ----------
  //
  // Stored diagram: { nodes: [{ id, kind: 'start'|'end'|'action'|'decision'|'bar', name, x, y, w? }],
  //                   edges: [{ id, type: 'flow', from, to, guard, route? }] }
  // Key: { actions: [{ ref, label?, name: [phrases] }],
  //        flows: [{ from, to, guard?, via?: 'fork'|'join', optional?, mistakes? }],
  //        allowExtra?: [phrases] }
  //   from / to: an action ref, "start" or "end", or a list of them. A list in "from" is several
  //   paths meeting at one target (one mark); a list in "to" with via "fork" is one fork (one mark).
  //
  // The student's graph is reduced to steps between anchors (start, end and the matched actions):
  // a step A -> B is any path from A to B through branch/merge diamonds, bars and extra actions,
  // with the guards and bars it passed. Steps are compared with the key's flows, so a separate
  // merge diamond, a merge+branch diamond, or one 3-way diamond instead of two nested ones all
  // grade the same. Layout rules (guards on every branch, one flow into an action) are checked
  // on the raw graph.

  const ACT_KINDS = ['start', 'end', 'action', 'decision', 'bar'];
  const isActivity = (d) => !!(d && Array.isArray(d.nodes) && d.nodes.some((n) => ACT_KINDS.includes(n.kind)));
  const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'is', 'are', 'be', 'for', 'on', 'in', 'at', 'it', 'its', 'this', 'that', 'with', 'by', 'from', 'into', 'and', 'or', 'has', 'have', 'was', 'there', 'their', 'his', 'her', 'any', 'up']);
  const NEG = new Set(['not', 'no', 'none', 'never', 'cannot', 'cant', 'isnt', 'arent', 'doesnt', 'dont', 'didnt', 'wasnt', 'without']);
  const SYN = { otherwise: 'else' };

  function stem(w) {
    let s = SYN[w] || w;
    if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
    else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
    else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
    else if (s.length > 3 && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
    else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
    if (s.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(s)) s = s.slice(0, -1);
    if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
    return s;
  }
  /** Words of a phrase, stemmed, without filler words; "neg" if it says not/no. */
  function words(str) {
    const t = String(str == null ? '' : str).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      .replace(/[’']/g, '').replace(/!=|≠/g, ' not ').replace(/!/g, ' not ')
      .replace(/>=|≥/g, ' ge ').replace(/<=|≤/g, ' le ').replace(/</g, ' lt ').replace(/>/g, ' gt ');
    const raw = t.split(/[^a-z0-9]+/).filter(Boolean);
    return { set: new Set(raw.filter((w) => !STOP.has(w) && !NEG.has(w)).map(stem)), neg: raw.some((w) => NEG.has(w)) };
  }
  /** 0 if text does not say phrase; otherwise how closely (1 = same words). */
  function phraseMatch(phrase, text) {
    const p = words(phrase), t = words(text);
    if (p.neg !== t.neg) return 0;
    if (!p.set.size) return t.set.size ? 0 : 1;
    for (const w of p.set) if (!t.set.has(w)) return 0;
    return p.set.size / Math.max(t.set.size, 1);
  }
  const saysAny = (phrases, text) => (listOf(phrases) || []).some((ph) => clean(ph) !== '' && phraseMatch(ph, text) > 0);

  function actGraph(diagram) {
    const nodes = (diagram.nodes || []).filter((n) => n && n.id);
    const byId = {};
    nodes.forEach((n) => { byId[n.id] = n; });
    const edges = (diagram.edges || []).filter((e) => e && byId[e.from] && byId[e.to]);
    const outs = {}, ins = {};
    nodes.forEach((n) => { outs[n.id] = []; ins[n.id] = []; });
    edges.forEach((e) => { outs[e.from].push(e); ins[e.to].push(e); });
    return { nodes, byId, edges, outs, ins };
  }

  /** Guard text of a flow. [yes]/[no] out of a labelled diamond are read as its question. */
  function effGuard(g, e) {
    const raw = clean(e.guard).replace(/^\[\s*(.*?)\s*\]$/, '$1');
    const src = g.byId[e.from];
    if (src.kind === 'decision' && clean(src.name)) {
      const q = clean(src.name).replace(/\?\s*$/, '');
      if (/^(yes|y|true|t)$/i.test(raw)) return { text: q, raw, fromLabel: true };
      if (/^(no|n|false|f)$/i.test(raw)) return { text: 'not ' + q, raw, fromLabel: true };
    }
    return { text: raw, raw };
  }

  /** Steps between anchor nodes: { nodeId: [{ to, guards, forks, joins, implicitForks, implicitJoins, branches, edges }] }. */
  function actSteps(g, isAnchor) {
    const T = {};
    for (const a of g.nodes) {
      if (!isAnchor(a)) continue;
      const list = (T[a.id] = []);
      const walk = (nid, st, seen) => {
        const here = g.byId[nid];
        const many = g.outs[nid].length > 1;
        for (const e of g.outs[nid]) {
          const n = g.byId[e.to];
          const gd = effGuard(g, e);
          const s = Object.assign({}, st, { guards: gd.text ? st.guards.concat(gd.text) : st.guards, edges: st.edges.concat(e.id) });
          if (many && here.kind === 'decision') { s.branches++; if (!gd.text) s.unguarded++; }
          if (many && isAnchor(here)) { if (gd.text) s.branches++; else s.implicitForks++; }
          if (isAnchor(n)) {
            if (g.ins[n.id].length > 1) s.implicitJoins++;
            list.push(Object.assign({ to: n.id }, s));
            continue;
          }
          if (seen.has(n.id)) continue;
          if (n.kind === 'bar') { if (g.outs[n.id].length > 1) s.forks++; if (g.ins[n.id].length > 1) s.joins++; }
          if (n.kind === 'decision' && g.ins[n.id].length > 1) s.merges++;
          walk(n.id, s, new Set(seen).add(n.id));
        }
      };
      walk(a.id, { guards: [], forks: 0, joins: 0, implicitForks: 0, implicitJoins: 0, branches: 0, merges: 0, unguarded: 0, edges: [] }, new Set([a.id]));
    }
    return T;
  }

  function gradeActivityDiagram(key, diagram) {
    const r = makeReporter();
    const g = actGraph(diagram);
    const { nodes, byId, outs, ins } = g;
    const actions = key.actions || [];
    const flows = key.flows || [];
    const keyAct = {};
    actions.forEach((a) => { keyAct[a.ref] = a; });
    const quote = (t) => (t.includes('"') ? t : `"${t}"`);
    const refLabel = (ref) => (ref === 'start' ? 'the start node' : ref === 'end' ? 'an end node'
      : quote(keyAct[ref] ? keyAct[ref].label || listOf(keyAct[ref].name)[0].replace(/^./, (c) => c.toUpperCase()) : ref));
    const nodeLabel = (n) => (n.kind === 'start' ? 'the start node' : n.kind === 'end' ? 'the end node'
      : n.kind === 'decision' ? 'this diamond' : n.kind === 'bar' ? 'this bar' : `"${clean(n.name)}"`);
    const whereOf = (n) => (n.kind === 'action' ? clean(n.name) || 'Action' : n.kind === 'decision' ? (clean(n.name) ? `◇ ${clean(n.name)}` : 'Branch/merge')
      : n.kind === 'bar' ? 'Fork/join bar' : n.kind === 'start' ? 'Start' : 'End');
    const names = (list) => { const l = list.map(refLabel); return l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]; };

    // ---- elements that do not belong ----
    nodes.filter((n) => !ACT_KINDS.includes(n.kind)).forEach((n) => r.error(clean(n.name) || 'Box', `"${clean(n.name)}" is a ${n.kind || 'class'} box. Activity diagrams are made of actions, diamonds, bars and start/end nodes.`, { node: n.id }));

    // ---- match actions by their words ----
    const acts = nodes.filter((n) => n.kind === 'action');
    acts.filter((n) => !clean(n.name)).forEach((n) => r.error('Action', 'An action has no name. Write the step in it, e.g. "Scan parcel".', { node: n.id }));
    const named = acts.filter((n) => clean(n.name));
    const nodeRef = {}, refNode = {};
    const cand = [];
    actions.forEach((a) => named.forEach((n) => {
      const s = Math.max(0, ...listOf(a.name).map((ph) => phraseMatch(ph, n.name)));
      if (s > 0) cand.push({ a, n, s });
    }));
    cand.sort((x, y) => y.s - x.s);
    for (const c of cand) if (!refNode[c.a.ref] && !nodeRef[c.n.id]) { refNode[c.a.ref] = c.n.id; nodeRef[c.n.id] = c.a.ref; }
    const starts = nodes.filter((n) => n.kind === 'start'), ends = nodes.filter((n) => n.kind === 'end');
    starts.forEach((n) => { nodeRef[n.id] = 'start'; });
    ends.forEach((n) => { nodeRef[n.id] = 'end'; });
    if (starts.length) refNode.start = starts[0].id;
    if (ends.length) refNode.end = ends[0].id;

    // an action in the place of a missing one, worded differently: half credit
    const missing0 = actions.filter((a) => !refNode[a.ref]);
    const free = named.filter((n) => !nodeRef[n.id] && !saysAny(key.allowExtra, n.name));
    if (missing0.length && free.length) {
      const T0 = actSteps(g, (n) => n.kind === 'start' || n.kind === 'end' || (n.kind === 'action' && clean(n.name)));
      const predsOf = (id) => Object.keys(T0).filter((a) => T0[a].some((t) => t.to === id));
      for (const a of missing0) {
        const kp = new Set(), ks = new Set();
        flows.forEach((f) => {
          if (listOf(f.to).includes(a.ref)) listOf(f.from).forEach((x) => kp.add(x));
          if (listOf(f.from).includes(a.ref)) listOf(f.to).forEach((x) => ks.add(x));
        });
        let best = null, bestS = 0, tie = false;
        for (const n of free) {
          if (nodeRef[n.id]) continue;
          const s = predsOf(n.id).filter((p) => kp.has(nodeRef[p])).length + (T0[n.id] || []).filter((t) => ks.has(nodeRef[t.to])).length;
          if (s > bestS) { best = n; bestS = s; tie = false; } else if (s === bestS && s > 0) tie = true;
        }
        if (best && !tie) {
          refNode[a.ref] = best.id; nodeRef[best.id] = a.ref;
          r.partial(clean(best.name), `"${clean(best.name)}" is where ${refLabel(a.ref)} should be, but it does not say that step (the key looks for words like "${listOf(a.name)[0]}"). If it means the same thing, this is only wording.`, { node: best.id }, 0.5);
        }
      }
    }
    named.filter((n) => !nodeRef[n.id]).forEach((n) => {
      if (saysAny(key.allowExtra, n.name)) return;
      r.error(clean(n.name), `"${clean(n.name)}" is not a step in the description. Remove it, or reword it if it is one of the steps.`, { node: n.id });
    });

    // ---- layout rules on the raw graph ----
    const noGuard = {}; // diamond id -> its missing-guard issue
    if (!starts.length) r.error('Start', 'No start node. Begin the activity with a filled circle.');
    if (starts.length > 1) r.error('Start', `There are ${starts.length} start nodes. An activity has one.`, { node: starts[1].id });
    if (!ends.length) r.error('End', 'No end node. Finish the activity with an end node (a dot inside a ring).');
    for (const n of nodes) {
      const ref = { node: n.id };
      const o = outs[n.id].length, i = ins[n.id].length;
      if (n.kind === 'start' && i) r.error('Start', 'A flow goes into the start node. The start node only has a flow out.', ref);
      if (n.kind === 'end' && o) r.error('End', 'A flow leaves an end node. Nothing follows an end node.', ref);
      if ((n.kind === 'action' || n.kind === 'start') && o > 1) {
        r.partial(whereOf(n), `${o} flows leave ${nodeLabel(n)}. Draw one flow out, into a branch node (diamond) with guards for a choice, or into a fork bar for steps that run at the same time.`, ref, 0.5);
      }
      if (n.kind === 'action' && i > 1) {
        r.partial(whereOf(n), `${i} flows enter ${nodeLabel(n)} directly. Bring them together first in a merge node (diamond), or in a join bar if they run at the same time.`, ref, 0.5);
      }
      if (n.kind === 'decision') {
        if (o > 1) {
          const gs = outs[n.id].map((e) => effGuard(g, e));
          if (gs.some((x) => !x.text)) { r.error(whereOf(n), 'Every flow leaving a branch node needs a guard in [ ], for example [more parcels] and [no more parcels].', ref); noGuard[n.id] = r.issues[r.issues.length - 1]; }
          const txt = gs.map((x) => x.text).filter(Boolean);
          const dup = txt.find((x, k) => txt.some((y, j) => j !== k && phraseMatch(x, y) === 1 && phraseMatch(y, x) === 1));
          if (dup) r.error(whereOf(n), `Two flows leaving this branch node have the same guard [${dup}]. Only one path can be taken, so the guards must differ.`, ref);
          if (gs.some((x) => x.fromLabel)) r.note(whereOf(n), `Guards [yes]/[no] are read using the diamond's text. Course style leaves the diamond empty and writes the condition on each flow, e.g. [${clean(n.name).replace(/\?\s*$/, '')}].`, ref);
        } else if (i <= 1) r.note(whereOf(n), 'This diamond neither branches nor merges. Remove it.', ref);
      }
      if (n.kind === 'bar' && o <= 1 && i <= 1) r.note(whereOf(n), 'This bar neither forks nor joins. Remove it.', ref);
    }
    for (const e of g.edges) {
      const src = byId[e.from];
      if (clean(e.guard) && src.kind !== 'decision' && outs[src.id].length <= 1) {
        r.note(whereOf(src), `The guard [${clean(e.guard).replace(/^\[|\]$/g, '')}] is on a flow that does not leave a branch node. Guards belong on the flows out of a diamond.`, { edge: e.id });
      }
    }

    // ---- compare steps with the key's flows ----
    const present = (ref) => !!refNode[ref];
    actions.filter((a) => !present(a.ref)).forEach((a) => r.error(refLabel(a.ref).replace(/"/g, ''), `Missing the action ${refLabel(a.ref)}.`));
    const T = actSteps(g, (n) => !!nodeRef[n.id]);
    const stepsOf = (a, b) => {
      const out = [];
      for (const [id, list] of Object.entries(T)) if (nodeRef[id] === a) list.forEach((t) => { if (nodeRef[t.to] === b) out.push(Object.assign({ fromNode: id }, t)); });
      return out;
    };
    const closure = (ref, side) => {
      const out = new Set(), seen = new Set([ref]);
      const go = (x) => flows.forEach((f) => {
        const [here, there] = side === 'succ' ? [listOf(f.from), listOf(f.to)] : [listOf(f.to), listOf(f.from)];
        if (!here.includes(x)) return;
        there.forEach((y) => { if (present(y)) out.add(y); else if (!seen.has(y)) { seen.add(y); go(y); } });
      });
      go(ref);
      return [...out];
    };
    const covered = new Set();
    const failedFrom = new Set(), failedTo = new Set();
    const nodeRefOf = (ref) => (refNode[ref] ? { node: refNode[ref] } : null);
    const guardOk = (f, t) => !f.guard || listOf(f.guard).includes('') || t.guards.some((x) => saysAny(f.guard, x));

    function problemOf(f, t, a) {
      const forkOK = t.forks + t.implicitForks > 0, joinOK = t.joins + t.implicitJoins > 0;
      if (f.via === 'fork' && !forkOK) return { kind: t.branches ? 'decision' : 'sequence', rank: 2, t };
      if (f.via === 'join' && !joinOK) return { kind: t.merges || t.branches ? 'merge' : 'sequence', rank: 2, t };
      if (!f.via && (t.forks || t.joins)) return { kind: 'fork', rank: 2, t };
      if (!guardOk(f, t)) {
        if (t.unguarded) return null; // reported once for the diamond
        if (t.guards.length) {
          const other = flows.find((o) => o !== f && o.guard && listOf(o.from).includes(a) && t.guards.some((x) => saysAny(o.guard, x)));
          return { kind: other ? 'swapped' : 'guard', rank: other ? 2 : 1, t, other };
        }
        if (forkOK && !t.branches) return { kind: 'fork', rank: 2, t };
      }
      return null;
    }
    function viaHint(f) {
      return f.via === 'fork' ? ' These steps happen at the same time: draw a fork bar with a flow to each.'
        : f.via === 'join' ? ' Both must finish before the next step: bring them into a join bar.' : '';
    }
    const swapped = new Set();
    const guardText = (f) => (f.guard ? ` when [${listOf(f.guard).find((x) => clean(x)) || ''}]` : '');

    flows.forEach((f) => {
      const F = listOf(f.from), To = listOf(f.to);
      F.forEach((a) => To.forEach((b) => covered.add(a + '|' + b)));
      const pf = F.filter(present), pt = To.filter(present);
      const at = pf[0] || pt[0];
      const where = at ? refLabel(at).replace(/"/g, '') : 'Flow';

      if (!pf.length || !pt.length) {
        // an end is missing: accept the path that skips it, so one missing step costs one mark
        const froms = pf.length ? pf : [...new Set(F.flatMap((x) => closure(x, 'pred')))];
        const tos = pt.length ? pt : [...new Set(To.flatMap((x) => closure(x, 'succ')))];
        const pairs = froms.flatMap((a) => tos.map((b) => [a, b]));
        pairs.forEach(([a, b]) => covered.add(a + '|' + b));
        if (f.optional || (pairs.length && pairs.every(([a, b]) => stepsOf(a, b).length))) return;
        pf.forEach((a) => failedFrom.add(a)); pt.forEach((b) => failedTo.add(b));
        r.error(where, `Missing the flow from ${names(F)} to ${names(To)}${guardText(f)}.`, at ? nodeRefOf(at) : null);
        return;
      }

      const gaps = [], probs = [];
      for (const a of pf) for (const b of pt) {
        const ts = stepsOf(a, b);
        if (!ts.length) { gaps.push([a, b]); continue; }
        let best = null;
        for (const t of ts) { const p = problemOf(f, t, a); if (!p) { best = null; break; } if (!best || p.rank < best.rank) best = p; }
        if (best) probs.push(best);
      }
      if (f.optional && gaps.length) return;
      if (gaps.length) {
        pf.forEach((a) => failedFrom.add(a)); pt.forEach((b) => failedTo.add(b));
        const ga = [...new Set(gaps.map((x) => x[0]))], gb = [...new Set(gaps.map((x) => x[1]))];
        // a known mistake: the path goes somewhere the key names
        for (const [a] of gaps) {
          const went = Object.entries(T).filter(([id]) => nodeRef[id] === a).flatMap(([, l]) => l.map((t) => nodeRef[t.to]));
          const mk = (f.mistakes || []).find((m) => m.to !== undefined && listOf(m.to).some((x) => went.includes(x)));
          if (mk) { reportMistake(r, where, mk, nodeRefOf(a)); return; }
        }
        // drawn one after the other instead of in parallel
        const chained = (f.via === 'fork' && To.some((x) => To.some((y) => x !== y && stepsOf(x, y).length)))
          || (f.via === 'join' && F.some((x) => F.some((y) => x !== y && stepsOf(x, y).length)));
        if (chained) {
          const mk = findMistake(f.mistakes, 'via', 'sequence');
          if (mk) { reportMistake(r, where, mk, nodeRefOf(at)); return; }
          r.error(where, `${names(f.via === 'fork' ? To : F)} are drawn one after the other, but they happen at the same time. Put them between a fork bar and a join bar.`, nodeRefOf(at));
          return;
        }
        r.error(where, `Missing the flow from ${names(ga)} to ${names(gb)}${guardText(f)}.${viaHint(f)}`, nodeRefOf(ga[0]));
        return;
      }
      if (!probs.length) return;
      const p = probs.sort((x, y) => y.rank - x.rank)[0];
      const ref = { edge: p.t.edges[p.t.edges.length - 1] };
      if (p.kind === 'decision') {
        // the diamond's missing guards are part of the same mistake
        p.t.edges.forEach((id) => { const d = noGuard[g.edges.find((e) => e.id === id).from]; if (d && r.issues.includes(d)) r.issues.splice(r.issues.indexOf(d), 1); });
      }
      const mk = p.kind === 'guard' || p.kind === 'swapped'
        ? (f.mistakes || []).find((m) => m.guard !== undefined && p.t.guards.some((x) => saysAny(m.guard, x)))
        : findMistake(f.mistakes, 'via', p.kind);
      if (mk) { reportMistake(r, where, mk, ref); return; }
      if (p.kind === 'swapped') { if (swapped.has(f)) return; swapped.add(p.other); }
      const A = names(F), B = names(To), shown = p.t.guards.map((x) => `[${x}]`).join(' then ');
      if (p.kind === 'decision') r.error(where, `After ${A}, ${B} all happen, at the same time. Use a fork bar, not a branch node: a branch takes only one path.`, ref);
      else if (p.kind === 'sequence') r.error(where, `${A} to ${B}: ${f.via === 'fork' ? 'these steps start together, so draw a fork bar.' : 'both must finish first, so draw a join bar.'}`, ref);
      else if (p.kind === 'merge') r.error(where, `${A} run at the same time, so ${B} must wait for all of them: use a join bar, not a merge node.`, ref);
      else if (p.kind === 'fork') r.error(where, `The path from ${A} to ${B} goes through a fork or join bar, but nothing runs in parallel here.${f.guard ? ' Only one path is taken: use a branch node with guards.' : ''}`, ref);
      else if (p.kind === 'swapped') r.error(where, `${shown} leads to ${names(listOf(p.other.to))} in the description, not to ${B}. The guards are swapped.`, ref);
      else r.partial(where, `The path from ${A} to ${B} is guarded ${shown}, but the condition here is [${listOf(f.guard).find((x) => clean(x))}]. If yours means the same thing, this is only wording.`, ref, 0.5);
    });

    // ---- steps the key does not have ----
    const said = new Set();
    for (const [id, list] of Object.entries(T)) {
      const a = nodeRef[id];
      for (const t of list) {
        const b = nodeRef[t.to];
        const k = a + '|' + b;
        if (covered.has(k) || failedFrom.has(a) || failedTo.has(b) || said.has(k)) continue;
        said.add(k);
        r.error(a === 'start' ? 'Start' : refLabel(a).replace(/"/g, ''), `Unexpected flow from ${refLabel(a)} to ${refLabel(b)}. The description does not go from one to the other.`, { edge: t.edges[0] });
      }
    }
    return r.issues;
  }

  function actToText(d) {
    const nm = {};
    let k = 0;
    (d.nodes || []).forEach((n) => {
      nm[n.id] = n.kind === 'action' ? `"${clean(n.name)}"` : n.kind === 'decision' ? `diamond${++k}${clean(n.name) ? ' "' + clean(n.name) + '"' : ''}` : n.kind === 'bar' ? `bar${++k}` : n.kind;
    });
    const lines = ['nodes: ' + (d.nodes || []).map((n) => nm[n.id]).join(', ')];
    (d.edges || []).forEach((e) => lines.push(`${nm[e.from]} -> ${nm[e.to]}${clean(e.guard) ? ' [' + clean(e.guard).replace(/^\[|\]$/g, '') + ']' : ''}`));
    return lines.join('\n');
  }

  // ---------- entry ----------

  function grade(part, diagram) {
    let issues;
    if (part.mode === 'sequence') issues = gradeSequenceDiagram(part.key, diagram || { lifelines: [], rows: [] });
    else if (part.mode === 'activity') issues = gradeActivityDiagram(part.key, diagram || { nodes: [], edges: [] });
    else {
      const d = diagram || { nodes: [], edges: [] };
      issues = part.mode === 'object' ? gradeObjectDiagram(part.key, d) : gradeClassDiagram(part.key, d);
    }
    return summarize(issues, maxMarks(part));
  }

  /** Plain-text dump of a diagram, for asking Claude or for debugging. */
  function toText(diagram) {
    if (diagram && diagram.rows) return seqToText(diagram);
    if (isActivity(diagram)) return actToText(diagram);
    const nodes = (diagram.nodes || []).map(normNode);
    const nm = {};
    nodes.forEach((n) => { nm[n.id] = n.name || '(unnamed)'; });
    const lines = [];
    for (const n of nodes) {
      const head = n.kind === 'object' ? `object ${n.name}` : `${n.stereo ? '<<' + n.stereo + '>> ' : ''}class ${n.name}`;
      lines.push(head);
      n.attrs.forEach((a) => lines.push('  ' + a));
      if (n.methods.length) { lines.push('  --'); n.methods.forEach((m) => lines.push('  ' + m)); }
    }
    for (const e of diagram.edges || []) {
      const bits = [];
      if (e.navTo) bits.push(`arrow at ${nm[e.to]}`);
      if (e.navFrom) bits.push(`arrow at ${nm[e.from]}`);
      if (clean(e.fromMult)) bits.push(`mult ${e.fromMult} at ${nm[e.from]}`);
      if (clean(e.toMult)) bits.push(`mult ${e.toMult} at ${nm[e.to]}`);
      if (clean(e.fromRole)) bits.push(`role ${e.fromRole} at ${nm[e.from]}`);
      if (clean(e.toRole)) bits.push(`role ${e.toRole} at ${nm[e.to]}`);
      if (clean(e.label)) bits.push(`label "${e.label}"`);
      lines.push(`${e.type}: ${nm[e.from]} -> ${nm[e.to]}${bits.length ? ' [' + bits.join(', ') + ']' : ''}`);
    }
    return lines.join('\n');
  }

  return { grade, toText, maxMarks, parseMember, parseHeader, normNode, buildSeqTree, parseCall, parseLifeline, START, actGraph, actSteps, phraseMatch, ACT_KINDS };
});
