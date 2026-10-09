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

  function makeReporter() {
    const issues = [];
    return {
      issues,
      error: (where, msg, ref) => issues.push({ sev: 'error', where, msg, ref: ref || null }),
      note: (where, msg, ref) => issues.push({ sev: 'note', where, msg, ref: ref || null }),
    };
  }

  const listOf = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);
  const typeIn = (t, list) => listOf(list).map(squash).includes(squash(t));
  const sigOf = (m) => `${m.vis || ''}${m.name}(${(m.params || []).map((p) => p.type).join(', ')})`;

  function summarize(issues) {
    return {
      errors: issues.filter((i) => i.sev === 'error').length,
      notes: issues.filter((i) => i.sev === 'note').length,
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
      local.error(where, `Wrong kind of line: drew ${TYPE_WORD[e.type] || e.type}, expected ${TYPE_WORD[rel.type]}.${rel.typeHint ? ' ' + rel.typeHint : ''}`, ref);
      return local.issues;
    }
    if (rel.acceptTypes && e.type !== rel.type && rel.acceptNote) local.note(where, rel.acceptNote, ref);

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
    const checkEnd = (field, label, wantList, end, otherEnd, cls, norm) => {
      if (!wantList) return;
      const list = listOf(wantList).map(norm);
      const got = norm(endVal(field, end));
      const other = norm(endVal(field, otherEnd));
      if (!got) {
        if (list.includes('')) return;
        if (other && list.includes(other)) local.error(where, `The ${label} "${other}" is at the wrong end. Put it next to ${cls}.`, ref);
        else local.error(where, `Add the ${label} next to ${cls}: ${list.filter(Boolean).join(' or ')}.`, ref);
      } else if (!list.includes(got)) {
        local.error(where, `${label[0].toUpperCase() + label.slice(1)} next to ${cls} should be ${list.filter(Boolean).join(' or ')}${list.includes('') ? ' (or left blank)' : ''}, not "${got}".`, ref);
      }
    };
    if (ASSOC_TYPES.includes(e.type)) {
      checkEnd('Mult', 'multiplicity', rel.toMult, atTo, atFrom, rel.to, normMult);
      checkEnd('Mult', 'multiplicity', rel.fromMult, atFrom, atTo, rel.from, normMult);
      checkEnd('Role', 'role', rel.toRole, atTo, atFrom, rel.to, clean);
      checkEnd('Role', 'role', rel.fromRole, atFrom, atTo, rel.from, clean);
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
        const score = iss.filter((i) => i.sev === 'error').length;
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
    for (const rel of key.relations || []) (listOf(rel.toRole) || []).forEach((x) => addRole(rel.from, x));

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
    for (const e of diagram.edges || []) {
      if (edgeOk.has(e.id)) continue;
      const a = ids[e.from], b = ids[e.to];
      if (!a || !b) continue;
      r.error(`${a.name} – ${b.name}`, `Unexpected link between ${a.name} and ${b.name}.`, { edge: e.id });
    }
    return r.issues;
  }

  // ---------- entry ----------

  function grade(part, diagram) {
    const d = diagram || { nodes: [], edges: [] };
    const issues = part.mode === 'object' ? gradeObjectDiagram(part.key, d) : gradeClassDiagram(part.key, d);
    return summarize(issues);
  }

  /** Plain-text dump of a diagram, for asking Claude or for debugging. */
  function toText(diagram) {
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

  return { grade, toText, parseMember, parseHeader, normNode };
});
