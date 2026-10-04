// Translates Wallpaper Engine shader text to GLSL ES 3.00 with the HLSL implicit conversions spelled out
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;

  class TranslateError extends Error {
    constructor(line, message) { super('line ' + line + ': ' + message); this.line = line; }
  }
  const fail = (line, message) => { throw new TranslateError(line, message); };

  // ------------------------------------------------------------------ lexing
  const PUNCT3 = ['<<=', '>>='];
  const PUNCT2 = ['++', '--', '<=', '>=', '==', '!=', '&&', '||', '^^', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
  const PUNCT1 = '+-*/%<>=!~&|^?:;,.()[]{}#';
  const NUMBER = /^(?:0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|\d+[eE][+-]?\d+[fF]?|\d+[fF]|\d+[uU]?)/;
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
  const EOF = { k: 'eof', v: '<end of shader>', line: 0 };

  // Words GLSL ES 3.00 reserves that HLSL flavoured shaders use as plain names
  const RESERVED = new Set(('sample filter input output half fixed double short long unsigned static extern inline volatile '
    + 'public class union enum typedef template this goto namespace using cast sizeof interface partition active asm common '
    + 'patch subroutine resource coherent restrict readonly writeonly noperspective external superp hvec2 hvec3 hvec4 dvec2 '
    + 'dvec3 dvec4 fvec2 fvec3 fvec4 atomic_uint sampler3DRect sampler1D sampler1DShadow sampler1DArray sampler1DArrayShadow '
    + 'isampler1D isampler1DArray usampler1D usampler1DArray sampler2DRect sampler2DRectShadow isampler2DRect usampler2DRect '
    + 'samplerBuffer isamplerBuffer usamplerBuffer sampler2DMS isampler2DMS usampler2DMS sampler2DMSArray isampler2DMSArray '
    + 'usampler2DMSArray samplerCubeArray samplerCubeArrayShadow isamplerCubeArray usamplerCubeArray image1D image2D image3D '
    + 'imageCube iimage1D iimage2D iimage3D iimageCube uimage1D uimage2D uimage3D uimageCube image1DArray image2DArray '
    + 'iimage1DArray iimage2DArray uimage1DArray uimage2DArray imageBuffer iimageBuffer uimageBuffer').split(' '));
  // WebGL also refuses identifiers with doubled underscores, so those are respelled too
  const PREDEFINED = new Set(['__VERSION__', '__LINE__', '__FILE__']);
  function rename(name) {
    if (RESERVED.has(name)) return name + '_';
    if (PREDEFINED.has(name)) return name;
    while (name.includes('__')) name = name.replace('__', '_x_');
    return name;
  }

  function lexLine(text, line, out) {
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i++; continue; }
      const rest = text.slice(i);
      let m;
      if ((m = IDENT.exec(rest)) !== null) { out.push({ k: 'id', v: rename(m[0]), line }); i += m[0].length; continue; }
      if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        m = NUMBER.exec(rest);
        if (!m) fail(line, 'malformed number near ' + rest.slice(0, 12));
        out.push({ k: 'num', v: m[0], line });
        i += m[0].length;
        continue;
      }
      const p3 = rest.slice(0, 3);
      const p2 = rest.slice(0, 2);
      if (PUNCT3.includes(p3)) { out.push({ k: 'op', v: p3, line }); i += 3; continue; }
      if (PUNCT2.includes(p2)) { out.push({ k: 'op', v: p2, line }); i += 2; continue; }
      if (PUNCT1.includes(c)) { out.push({ k: 'op', v: c, line }); i += 1; continue; }
      fail(line, 'unexpected character ' + JSON.stringify(c));
    }
  }

  function stripComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end < 0 ? text.length : end + 2;
        for (let j = i; j < stop; j++) if (text[j] === '\n') out += '\n';
        i = stop;
        continue;
      }
      out += text[i++];
    }
    return out;
  }

  // ----------------------------------------------------------- preprocessing
  function objectMacro(text) { const body = []; lexLine(text, 0, body); return { params: null, body }; }

  function preprocess(text) {
    const lines = stripComments(text.replace(/\r\n?/g, '\n').replace(/\\\n/g, '')).split('\n');
    let macros = new Map([['__VERSION__', objectMacro('300')], ['GL_ES', objectMacro('1')], ['__FILE__', objectMacro('0')]]);
    const cond = [];
    const tokens = [];
    const directives = [];
    const active = () => cond.length === 0 || cond[cond.length - 1].active;
    for (let n = 0; n < lines.length; n++) {
      const line = n + 1;
      const raw = lines[n];
      const trimmed = raw.trim();
      if (trimmed[0] !== '#') {
        if (!active()) continue;
        const start = tokens.length;
        lexLine(raw, line, tokens);
        for (let i = start; i < tokens.length; i++) tokens[i].env = macros;
        continue;
      }
      const m = /^#[ \t]*([A-Za-z_]*)[ \t]*(.*)$/.exec(trimmed);
      const name = m[1];
      const rest = m[2].trim();
      const top = cond[cond.length - 1];
      switch (name) {
        case 'if': {
          const parent = active();
          const on = parent && evalCondition(rest, line, macros) !== 0;
          cond.push({ parent, taken: on, active: on });
          continue;
        }
        case 'ifdef':
        case 'ifndef': {
          const parent = active();
          const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
          if (!id) fail(line, '#' + name + ' without a name');
          const has = macros.has(rename(id[0]));
          const on = parent && (name === 'ifdef' ? has : !has);
          cond.push({ parent, taken: on, active: on });
          continue;
        }
        case 'elif': {
          if (!top) fail(line, '#elif without #if');
          const on = top.parent && !top.taken && evalCondition(rest, line, macros) !== 0;
          top.active = on;
          top.taken = top.taken || on;
          continue;
        }
        case 'else': {
          if (!top) fail(line, '#else without #if');
          top.active = top.parent && !top.taken;
          top.taken = true;
          continue;
        }
        case 'endif':
          if (!top) fail(line, '#endif without #if');
          cond.pop();
          continue;
        default:
          break;
      }
      if (!active()) continue;
      switch (name) {
        case 'define': {
          const d = /^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?[ \t]*(.*)$/.exec(rest);
          if (!d) fail(line, 'malformed #define ' + rest);
          const body = [];
          lexLine(d[4], line, body);
          const params = d[2] ? d[3].split(',').map((s) => rename(s.trim())).filter((s) => s.length) : null;
          macros = new Map(macros);
          macros.set(rename(d[1]), { params, body });
          break;
        }
        case 'undef': {
          const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
          if (!id) fail(line, '#undef without a name');
          macros = new Map(macros);
          macros.delete(rename(id[0]));
          break;
        }
        case 'extension':
        case 'pragma':
          directives.push('#' + name + ' ' + rest);
          break;
        case 'version':
        case 'line':
        case '':
          break;
        case 'error':
          fail(line, '#error ' + rest);
          break;
        case 'include':
          fail(line, 'unresolved #include ' + rest);
          break;
        default:
          fail(line, 'unknown directive #' + name);
      }
    }
    if (cond.length) fail(lines.length, '#if without #endif');
    return { tokens: expand(tokens, { shadowed: new Set() }), directives };
  }

  const union = (a, b) => { if (!a) return b; if (!b) return a; const s = new Set(a); for (const x of b) s.add(x); return s; };

  // A shader defining a function under a macro name owns that name from there on like HLSL
  function definesFunction(out, src, i) {
    const prev = out[out.length - 1];
    const next = src[i + 1];
    return !!prev && prev.k === 'id' && TYPE_NAMES.has(prev.v) && !!next && next.k === 'op' && next.v === '(';
  }

  // Macro expansion with hide sets so a macro never re-expands inside its own output
  function expand(tokens, ctx) {
    const out = [];
    const src = tokens.slice();
    let i = 0;
    while (i < src.length) {
      const t = src[i];
      if (t.k === 'id' && t.v === '__LINE__') { out.push({ k: 'num', v: String(t.line), line: t.line }); i++; continue; }
      const m = t.k === 'id' && t.env && !ctx.shadowed.has(t.v) && !(t.hide && t.hide.has(t.v)) ? t.env.get(t.v) : undefined;
      if (!m) { out.push(t); i++; continue; }
      if (definesFunction(out, src, i)) { ctx.shadowed.add(t.v); out.push(t); i++; continue; }
      const hide = new Set(t.hide || []);
      hide.add(t.v);
      if (m.params === null) {
        src.splice(i, 1, ...m.body.map((b) => ({ k: b.k, v: b.v, line: t.line, env: t.env, hide })));
        continue;
      }
      const open = src[i + 1];
      if (!(open && open.k === 'op' && open.v === '(')) { out.push(t); i++; continue; }
      let depth = 0;
      let j = i + 1;
      const args = [[]];
      for (; j < src.length; j++) {
        const a = src[j];
        if (a.k === 'op' && a.v === '(') { if (depth++ > 0) args[args.length - 1].push(a); continue; }
        if (a.k === 'op' && a.v === ')') { if (--depth === 0) break; args[args.length - 1].push(a); continue; }
        if (a.k === 'op' && a.v === ',' && depth === 1) { args.push([]); continue; }
        args[args.length - 1].push(a);
      }
      if (j >= src.length) fail(t.line, 'unterminated arguments of macro ' + t.v);
      if (m.params.length === 0 && args.length === 1 && args[0].length === 0) args.length = 0;
      if (args.length !== m.params.length) fail(t.line, 'macro ' + t.v + ' takes ' + m.params.length + ' arguments, given ' + args.length);
      const expandedArgs = args.map((a) => expand(a, ctx));
      const body = [];
      for (const b of m.body) {
        const p = b.k === 'id' ? m.params.indexOf(b.v) : -1;
        if (p >= 0) for (const a of expandedArgs[p]) body.push({ k: a.k, v: a.v, line: t.line, env: t.env, hide: union(a.hide, hide) });
        else body.push({ k: b.k, v: b.v, line: t.line, env: t.env, hide });
      }
      src.splice(i, j - i + 1, ...body);
    }
    return out;
  }

  function evalCondition(text, line, macros) {
    const raw = [];
    lexLine(text, line, raw);
    const pre = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (t.k === 'id' && t.v === 'defined') {
        let j = i + 1;
        const paren = raw[j] && raw[j].k === 'op' && raw[j].v === '(';
        if (paren) j++;
        const id = raw[j];
        if (!id || id.k !== 'id') fail(line, 'defined without a name');
        if (paren) { j++; if (!(raw[j] && raw[j].v === ')')) fail(line, 'defined( without )'); }
        pre.push({ k: 'num', v: macros.has(id.v) ? '1' : '0', line });
        i = j;
        continue;
      }
      pre.push({ k: t.k, v: t.v, line, env: macros });
    }
    const toks = expand(pre, { shadowed: new Set() }).map((t) => (t.k === 'id' ? { k: 'num', v: t.v === 'true' ? '1' : '0', line } : t));
    let p = 0;
    const peek = () => toks[p] || EOF;
    const take = (v) => { if (peek().v !== v) fail(line, 'expected ' + v + ' in #if ' + text); p++; };
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    const unary = () => {
      const t = peek();
      if (t.k === 'op' && (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~')) {
        p++;
        const v = unary();
        return t.v === '!' ? (v ? 0 : 1) : t.v === '-' ? -v : t.v === '~' ? ~v : v;
      }
      if (t.k === 'op' && t.v === '(') { p++; const v = ternary(); take(')'); return v; }
      if (t.k === 'num') { p++; return numberValue(t.v, line); }
      fail(line, 'cannot evaluate #if ' + text);
      return 0;
    };
    const binary = (level) => {
      if (level === LEVELS.length) return unary();
      let l = binary(level + 1);
      for (;;) {
        const t = peek();
        if (t.k !== 'op' || !LEVELS[level].includes(t.v)) return l;
        p++;
        const r = binary(level + 1);
        switch (t.v) {
          case '||': l = l || r ? 1 : 0; break;
          case '&&': l = l && r ? 1 : 0; break;
          case '|': l |= r; break;
          case '^': l ^= r; break;
          case '&': l &= r; break;
          case '==': l = l === r ? 1 : 0; break;
          case '!=': l = l !== r ? 1 : 0; break;
          case '<': l = l < r ? 1 : 0; break;
          case '>': l = l > r ? 1 : 0; break;
          case '<=': l = l <= r ? 1 : 0; break;
          case '>=': l = l >= r ? 1 : 0; break;
          case '<<': l <<= r; break;
          case '>>': l >>= r; break;
          case '+': l += r; break;
          case '-': l -= r; break;
          case '*': l *= r; break;
          case '/': if (r === 0) fail(line, 'division by zero in #if ' + text); l = Math.trunc(l / r); break;
          case '%': if (r === 0) fail(line, 'division by zero in #if ' + text); l %= r; break;
          default: break;
        }
      }
    };
    const ternary = () => {
      const c = binary(0);
      if (peek().v !== '?') return c;
      p++;
      const a = ternary();
      take(':');
      const b = ternary();
      return c ? a : b;
    };
    const v = ternary();
    if (peek().k !== 'eof') fail(line, 'trailing tokens in #if ' + text);
    return v;
  }

  function numberValue(text, line) {
    const t = text.replace(/[uUfF]$/, '');
    let v;
    if (/^0[xX]/.test(t)) v = parseInt(t.slice(2), 16);
    else if (/^0[0-7]+$/.test(t)) v = parseInt(t, 8);
    else v = Number(t);
    if (!Number.isFinite(v)) fail(line, 'malformed number ' + text);
    return v;
  }

  // ------------------------------------------------------------------- types
  const SAMPLERS = {
    sampler2D: { dim: 2, coord: 2, texel: 'float' },
    sampler3D: { dim: 3, coord: 3, texel: 'float' },
    samplerCube: { dim: 2, coord: 3, texel: 'float' },
    sampler2DArray: { dim: 3, coord: 3, texel: 'float' },
    sampler2DShadow: { dim: 2, coord: 3, texel: 'float', shadow: true },
    samplerCubeShadow: { dim: 2, coord: 4, texel: 'float', shadow: true },
    sampler2DArrayShadow: { dim: 3, coord: 4, texel: 'float', shadow: true },
    isampler2D: { dim: 2, coord: 2, texel: 'int' },
    isampler3D: { dim: 3, coord: 3, texel: 'int' },
    isamplerCube: { dim: 2, coord: 3, texel: 'int' },
    isampler2DArray: { dim: 3, coord: 3, texel: 'int' },
    usampler2D: { dim: 2, coord: 2, texel: 'uint' },
    usampler3D: { dim: 3, coord: 3, texel: 'uint' },
    usamplerCube: { dim: 2, coord: 3, texel: 'uint' },
    usampler2DArray: { dim: 3, coord: 3, texel: 'uint' },
  };
  const SCALAR_BASES = new Set(['float', 'int', 'uint', 'bool']);
  const VEC_PREFIX = { float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec' };
  const VOID = { b: 'void' };
  const TYPE_NAMES = new Set(['void', 'float', 'int', 'uint', 'bool', ...Object.keys(SAMPLERS)]);
  for (const p of ['', 'i', 'u', 'b']) for (const n of [2, 3, 4]) TYPE_NAMES.add(p + 'vec' + n);
  for (const c of [2, 3, 4]) { TYPE_NAMES.add('mat' + c); for (const r of [2, 3, 4]) TYPE_NAMES.add('mat' + c + 'x' + r); }

  function scalar(b) { return { b, n: 1 }; }
  function vec(b, n) { return n === 1 ? scalar(b) : { b, n }; }
  function mat(cols, rows) { return { mat: true, cols, rows }; }

  function typeFromName(name, structs) {
    if (SCALAR_BASES.has(name)) return scalar(name);
    let m = /^([iub]?)vec([234])$/.exec(name);
    if (m) return vec({ '': 'float', i: 'int', u: 'uint', b: 'bool' }[m[1]], +m[2]);
    m = /^mat([234])(?:x([234]))?$/.exec(name);
    if (m) return mat(+m[1], m[2] ? +m[2] : +m[1]);
    if (name in SAMPLERS) return { sampler: name };
    if (name === 'void') return VOID;
    if (structs && structs.has(name)) return structs.get(name);
    return null;
  }

  function typeName(t) {
    if (t.arr) return typeName(t.arr);
    if (t.mat) return t.cols === t.rows ? 'mat' + t.cols : 'mat' + t.cols + 'x' + t.rows;
    if (t.sampler) return t.sampler;
    if (t.struct) return t.struct;
    return t.n === 1 ? t.b : VEC_PREFIX[t.b] + t.n;
  }

  function same(a, b) {
    if (!a || !b) return false;
    if (a.arr || b.arr) return !!(a.arr && b.arr) && a.size === b.size && same(a.arr, b.arr);
    if (a.mat || b.mat) return !!(a.mat && b.mat) && a.cols === b.cols && a.rows === b.rows;
    if (a.sampler || b.sampler) return a.sampler === b.sampler;
    if (a.struct || b.struct) return a.struct === b.struct;
    return a.b === b.b && a.n === b.n;
  }

  const isNumeric = (t) => !!t && t.n !== undefined && t.b !== 'void';
  const RANK = { bool: 0, int: 1, uint: 2, float: 3 };
  const wider = (a, b) => (RANK[a] >= RANK[b] ? a : b);

  // ------------------------------------------------------------------ parsing
  const QUALIFIERS = new Set(['const', 'in', 'out', 'inout', 'uniform', 'varying', 'attribute', 'flat', 'smooth', 'centroid', 'invariant', 'highp', 'mediump', 'lowp', 'static', 'precise']);
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);
  const BINARY_LEVELS = [['||'], ['^^'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  class Parser {
    constructor(tokens) {
      this.t = tokens;
      this.i = 0;
      this.structs = new Set();
      this.anonymous = 0;
    }

    peek(o = 0) { return this.t[this.i + o] || EOF; }
    next() { return this.t[this.i++] || EOF; }
    is(v, o = 0) { const t = this.peek(o); return t.k !== 'num' && t.v === v; }
    expect(v) {
      if (!this.is(v)) fail(this.peek().line, 'expected ' + v + ' but found ' + this.peek().v);
      return this.next();
    }

    ident() {
      const t = this.next();
      if (t.k !== 'id') fail(t.line, 'expected a name but found ' + t.v);
      return t.v;
    }

    isTypeName(t) { return t.k === 'id' && (TYPE_NAMES.has(t.v) || this.structs.has(t.v)); }

    unit() {
      const items = [];
      while (this.peek().k !== 'eof') {
        if (this.is(';')) { this.next(); continue; }
        items.push(this.external());
      }
      return items;
    }

    external() {
      const line = this.peek().line;
      if (this.is('precision')) {
        this.next();
        const q = this.ident();
        const type = this.ident();
        this.expect(';');
        return { k: 'precision', q, type, line };
      }
      const quals = this.qualifiers();
      if (quals.length === 1 && quals[0] === 'invariant' && this.peek().k === 'id' && this.is(';', 1)) {
        const name = this.ident();
        this.expect(';');
        return { k: 'raw', text: 'invariant ' + name + ';', line };
      }
      if (this.is('struct')) {
        const struct = this.structDef();
        const declarators = this.is(';') ? [] : this.declarators();
        this.expect(';');
        return { k: 'decl', quals, type: struct.name, dims: [], declarators, struct, line };
      }
      const type = this.typeSpec();
      const name = this.ident();
      if (this.is('(')) return this.func(quals, type, name, line);
      const declarators = this.declarators(name);
      this.expect(';');
      return { k: 'decl', quals, type: type.name, dims: type.dims, declarators, line };
    }

    qualifiers() {
      const quals = [];
      for (;;) {
        const t = this.peek();
        if (t.k !== 'id') break;
        if (QUALIFIERS.has(t.v)) { quals.push(this.next().v); continue; }
        if (t.v === 'layout') {
          this.next();
          this.expect('(');
          let depth = 1;
          let text = 'layout(';
          while (depth > 0) {
            const u = this.next();
            if (u.k === 'eof') fail(t.line, 'unterminated layout(');
            if (u.v === '(') depth++;
            if (u.v === ')') depth--;
            if (depth > 0) text += (u.k === 'op' ? u.v : ' ' + u.v + ' ');
          }
          quals.push(text.replace(/\s+/g, ' ').trim() + ')');
          continue;
        }
        break;
      }
      return quals;
    }

    typeSpec() {
      const t = this.next();
      if (t.k !== 'id') fail(t.line, 'expected a type but found ' + t.v);
      return { name: t.v, dims: this.dims() };
    }

    dims() {
      const dims = [];
      while (this.is('[')) {
        this.next();
        dims.push(this.is(']') ? null : this.expression());
        this.expect(']');
      }
      return dims;
    }

    structDef() {
      const line = this.expect('struct').line;
      const name = this.peek().k === 'id' ? this.ident() : '_weStruct' + this.anonymous++;
      this.expect('{');
      const fields = [];
      while (!this.is('}')) {
        const quals = this.qualifiers();
        const type = this.typeSpec();
        for (;;) {
          const fname = this.ident();
          fields.push({ quals, type: type.name, dims: type.dims.concat(this.dims()), name: fname });
          if (this.is(',')) { this.next(); continue; }
          break;
        }
        this.expect(';');
      }
      this.expect('}');
      this.structs.add(name);
      return { name, fields, line };
    }

    declarators(first) {
      const out = [];
      for (;;) {
        const line = this.peek().line;
        const name = first !== undefined ? first : this.ident();
        first = undefined;
        const dims = this.dims();
        let init = null;
        if (this.is('=')) {
          this.next();
          init = this.initializer();
        }
        out.push({ name, dims, init, line });
        if (this.is(',')) { this.next(); continue; }
        return out;
      }
    }

    initializer() {
      if (!this.is('{')) return this.assignment();
      const line = this.next().line;
      const items = [];
      while (!this.is('}')) {
        items.push(this.initializer());
        if (this.is(',')) this.next();
      }
      this.expect('}');
      return { k: 'init', items, line };
    }

    func(quals, type, name, line) {
      this.expect('(');
      const params = [];
      if (this.is('void') && this.is(')', 1)) this.next();
      while (!this.is(')')) {
        const pquals = this.qualifiers();
        const ptype = this.typeSpec();
        const pname = this.peek().k === 'id' ? this.ident() : null;
        params.push({ quals: pquals, type: ptype.name, dims: ptype.dims.concat(this.dims()), name: pname });
        if (this.is(',')) this.next();
        else if (!this.is(')')) fail(this.peek().line, 'expected , or ) in the parameters of ' + name);
      }
      this.expect(')');
      let body = null;
      if (this.is(';')) this.next();
      else body = this.block();
      return { k: 'func', quals, type: type.name, dims: type.dims, name, params, body, line };
    }

    block() {
      const line = this.expect('{').line;
      const stmts = [];
      while (!this.is('}')) {
        if (this.peek().k === 'eof') fail(line, 'block without a closing }');
        stmts.push(this.statement());
      }
      this.expect('}');
      return { k: 'block', stmts, line };
    }

    isDeclStart() {
      const t = this.peek();
      if (t.k !== 'id') return false;
      if (QUALIFIERS.has(t.v) || t.v === 'struct' || t.v === 'layout') return true;
      if (!this.isTypeName(t)) return false;
      const n = this.peek(1);
      if (n.k === 'id') return true;
      if (n.k === 'op' && n.v === '[') {
        let depth = 0;
        let o = 1;
        for (;; o++) {
          const u = this.peek(o);
          if (u.k === 'eof') return false;
          if (u.v === '[') depth++;
          else if (u.v === ']' && --depth === 0) break;
        }
        return this.peek(o + 1).k === 'id';
      }
      return false;
    }

    declStmt() {
      const line = this.peek().line;
      const quals = this.qualifiers();
      if (this.is('struct')) {
        const struct = this.structDef();
        const declarators = this.is(';') ? [] : this.declarators();
        return { k: 'decl', quals, type: struct.name, dims: [], declarators, struct, line };
      }
      const type = this.typeSpec();
      return { k: 'decl', quals, type: type.name, dims: type.dims, declarators: this.declarators(), line };
    }

    statement() {
      const t = this.peek();
      const line = t.line;
      if (this.is('{')) return this.block();
      if (this.is(';')) { this.next(); return { k: 'empty', line }; }
      if (t.k === 'id') {
        switch (t.v) {
          case 'if': {
            this.next();
            this.expect('(');
            const c = this.expression();
            this.expect(')');
            const a = this.statement();
            let b = null;
            if (this.is('else')) { this.next(); b = this.statement(); }
            return { k: 'if', c, a, b, line };
          }
          case 'for': {
            this.next();
            this.expect('(');
            const init = this.is(';') ? null : (this.isDeclStart() ? this.declStmt() : { k: 'expr', e: this.expression(), line });
            this.expect(';');
            const c = this.is(';') ? null : this.expression();
            this.expect(';');
            const step = this.is(')') ? null : this.expression();
            this.expect(')');
            return { k: 'for', init, c, step, body: this.statement(), line };
          }
          case 'while': {
            this.next();
            this.expect('(');
            const c = this.expression();
            this.expect(')');
            return { k: 'while', c, body: this.statement(), line };
          }
          case 'do': {
            this.next();
            const body = this.statement();
            this.expect('while');
            this.expect('(');
            const c = this.expression();
            this.expect(')');
            this.expect(';');
            return { k: 'do', c, body, line };
          }
          case 'switch': {
            this.next();
            this.expect('(');
            const e = this.expression();
            this.expect(')');
            this.expect('{');
            const cases = [];
            while (!this.is('}')) {
              if (this.is('case')) { this.next(); const v = this.expression(); this.expect(':'); cases.push({ label: v, stmts: [], line }); continue; }
              if (this.is('default')) { this.next(); this.expect(':'); cases.push({ label: null, stmts: [], line }); continue; }
              if (!cases.length) fail(this.peek().line, 'statement before the first case label');
              cases[cases.length - 1].stmts.push(this.statement());
            }
            this.expect('}');
            return { k: 'switch', e, cases, line };
          }
          case 'return': {
            this.next();
            const e = this.is(';') ? null : this.expression();
            this.expect(';');
            return { k: 'return', e, line };
          }
          case 'break':
          case 'continue':
          case 'discard':
            this.next();
            this.expect(';');
            return { k: t.v, line };
          default:
            break;
        }
      }
      if (this.isDeclStart()) {
        const d = this.declStmt();
        this.expect(';');
        return d;
      }
      const e = this.expression();
      this.expect(';');
      return { k: 'expr', e, line };
    }

    expression() {
      let e = this.assignment();
      while (this.is(',')) { const line = this.next().line; e = { k: 'seq', l: e, r: this.assignment(), line }; }
      return e;
    }

    assignment() {
      const l = this.ternary();
      const t = this.peek();
      if (t.k === 'op' && ASSIGN_OPS.has(t.v)) {
        this.next();
        return { k: 'asg', op: t.v, l, r: this.assignment(), line: t.line };
      }
      return l;
    }

    ternary() {
      const c = this.binary(0);
      if (!this.is('?')) return c;
      const line = this.next().line;
      const a = this.expression();
      this.expect(':');
      const b = this.assignment();
      return { k: 'cond', c, a, b, line };
    }

    binary(level) {
      if (level === BINARY_LEVELS.length) return this.unary();
      let l = this.binary(level + 1);
      for (;;) {
        const t = this.peek();
        if (t.k !== 'op' || !BINARY_LEVELS[level].includes(t.v)) return l;
        this.next();
        l = { k: 'bin', op: t.v, l, r: this.binary(level + 1), line: t.line };
      }
    }

    unary() {
      const t = this.peek();
      if (t.k === 'op' && ['+', '-', '!', '~', '++', '--'].includes(t.v)) {
        this.next();
        return { k: 'un', op: t.v, e: this.unary(), line: t.line };
      }
      return this.postfix();
    }

    postfix() {
      let e = this.primary();
      for (;;) {
        const t = this.peek();
        if (t.k !== 'op') break;
        if (t.v === '[') {
          this.next();
          const i = this.expression();
          this.expect(']');
          e = { k: 'idx', e, i, line: t.line };
          continue;
        }
        if (t.v === '.') {
          this.next();
          const name = this.ident();
          if (this.is('(')) {
            this.next();
            this.expect(')');
            if (name !== 'length') fail(t.line, 'unknown method .' + name + '()');
            e = { k: 'len', e, line: t.line };
          } else {
            e = { k: 'mem', e, name, line: t.line };
          }
          continue;
        }
        if (t.v === '++' || t.v === '--') {
          this.next();
          e = { k: 'post', op: t.v, e, line: t.line };
          continue;
        }
        break;
      }
      return e;
    }

    primary() {
      const t = this.next();
      if (t.k === 'num') return { k: 'num', v: t.v, line: t.line };
      if (t.k === 'op' && t.v === '(') {
        const e = this.expression();
        this.expect(')');
        return e;
      }
      if (t.k === 'id') {
        if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true', line: t.line };
        if (this.isTypeName(t)) {
          const dims = this.dims();
          this.expect('(');
          return { k: 'call', name: t.v, dims, args: this.args(), ctor: true, line: t.line };
        }
        if (this.is('(')) {
          this.next();
          return { k: 'call', name: t.v, args: this.args(), line: t.line };
        }
        return { k: 'id', name: t.v, line: t.line };
      }
      fail(t.line, 'unexpected ' + (t.k === 'eof' ? 'end of shader' : t.v));
      return null;
    }

    args() {
      const out = [];
      if (this.is(')')) { this.next(); return out; }
      for (;;) {
        out.push(this.assignment());
        if (this.is(',')) { this.next(); continue; }
        this.expect(')');
        return out;
      }
    }
  }

  // ----------------------------------------------------- builtin signatures
  const BUILTINS = new Map();
  function parseSig(sig) {
    const [params, ret] = sig.split('->');
    return { params: params === '' ? [] : params.split(','), ret };
  }
  function def(names, ...sigs) {
    for (const n of names.split(' ')) {
      if (!BUILTINS.has(n)) BUILTINS.set(n, []);
      BUILTINS.get(n).push(...sigs.map(parseSig));
    }
  }
  def('radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh exp log exp2 log2 sqrt inversesqrt floor trunc round roundEven ceil fract normalize dFdx dFdy fwidth', 'g->g');
  def('atan pow', 'g,g->g');
  def('mod', 'g,g->g', 'g,f->g');
  def('abs sign', 'g->g', 'i->i');
  def('modf', 'g,g->g');
  def('min max', 'g,g->g', 'g,f->g', 'i,i->i', 'i,I->i', 'u,u->u', 'u,U->u');
  def('clamp', 'g,g,g->g', 'g,f,f->g', 'i,i,i->i', 'i,I,I->i', 'u,u,u->u', 'u,U,U->u');
  def('mix', 'g,g,g->g', 'g,g,f->g', 'g,g,b->g');
  def('step', 'g,g->g', 'f,g->g');
  def('smoothstep', 'g,g,g->g', 'f,f,g->g');
  def('isnan isinf', 'g->b');
  def('floatBitsToInt', 'g->i');
  def('floatBitsToUint', 'g->u');
  def('intBitsToFloat', 'i->g');
  def('uintBitsToFloat', 'u->g');
  def('packSnorm2x16 packUnorm2x16 packHalf2x16', 'vec2->U');
  def('unpackSnorm2x16 unpackUnorm2x16 unpackHalf2x16', 'U->vec2');
  def('length', 'g->f');
  def('distance dot', 'g,g->f');
  def('cross', 'vec3,vec3->vec3');
  def('faceforward', 'g,g,g->g');
  def('reflect', 'g,g->g');
  def('refract', 'g,g,f->g');
  def('matrixCompMult', 'm,m->m');
  def('inverse', 'm->m');
  def('transpose', 'm->mT');
  def('determinant', 'm->f');
  def('outerProduct', 'v,v->mO');
  def('lessThan lessThanEqual greaterThan greaterThanEqual', 'v,v->bv', 'iv,iv->bv', 'uv,uv->bv');
  def('equal notEqual', 'v,v->bv', 'iv,iv->bv', 'uv,uv->bv', 'bv,bv->bv');
  def('any all', 'bv->B');
  def('not', 'bv->bv');
  const TEXTURE_FUNCS = new Set(['texture', 'textureProj', 'textureLod', 'textureOffset', 'texelFetch', 'texelFetchOffset', 'textureProjOffset', 'textureLodOffset', 'textureProjLod', 'textureProjLodOffset', 'textureGrad', 'textureGradOffset', 'textureProjGrad', 'textureProjGradOffset', 'textureSize']);
  const GEN = { g: 'float', i: 'int', u: 'uint', b: 'bool' };
  const VECK = { v: 'float', iv: 'int', uv: 'uint', bv: 'bool' };
  const SCALK = { f: 'float', I: 'int', U: 'uint', B: 'bool' };

  // WebGL has a single viewport, which is where every index lands, so the index is a plain int
  const VIEWPORT_INDEX = '_weViewportIndex';
  const BUILTIN_VARS = new Map(Object.entries({
    gl_ViewportIndex: scalar('int'),
    gl_Position: vec('float', 4), gl_PointSize: scalar('float'), gl_FragCoord: vec('float', 4), gl_FrontFacing: scalar('bool'),
    gl_PointCoord: vec('float', 2), gl_FragDepth: scalar('float'), gl_VertexID: scalar('int'), gl_InstanceID: scalar('int'),
    gl_MaxVertexAttribs: scalar('int'), gl_MaxVertexUniformVectors: scalar('int'), gl_MaxVertexOutputVectors: scalar('int'),
    gl_MaxFragmentInputVectors: scalar('int'), gl_MaxVertexTextureImageUnits: scalar('int'), gl_MaxCombinedTextureImageUnits: scalar('int'),
    gl_MaxTextureImageUnits: scalar('int'), gl_MaxFragmentUniformVectors: scalar('int'), gl_MaxDrawBuffers: scalar('int'),
    gl_MinProgramTexelOffset: scalar('int'), gl_MaxProgramTexelOffset: scalar('int'),
  }));

  // Cost of turning from into to the way HLSL would or -1 when HLSL refuses too
  function convCost(from, to) {
    if (same(from, to)) return 0;
    if (!isNumeric(from) || !isNumeric(to)) return -1;
    if (from.n === to.n) return 1;
    if (from.n === 1) return 2;
    if (to.n === 1 || to.n < from.n) return 3 + (from.b === to.b ? 0 : 1);
    return -1;
  }

  function matchSig(sig, ts) {
    if (sig.params.length !== ts.length) return null;
    const gen = [];
    const vecs = [];
    ts.forEach((t, k) => {
      const kind = sig.params[k];
      if (!isNumeric(t)) return;
      if (GEN[kind]) gen.push(t.n);
      else if (VECK[kind]) vecs.push(t.n);
    });
    const attempts = gen.length ? [...new Set([Math.max(...gen), Math.min(...gen)])] : [1];
    const V = vecs.length ? Math.max(...vecs) : 2;
    for (const S of attempts) {
      let cost = 0;
      const targets = [];
      let ok = true;
      let M = null;
      for (let k = 0; k < ts.length && ok; k++) {
        const kind = sig.params[k];
        const t = ts[k];
        if (!t) { targets.push(null); continue; }
        let target;
        if (GEN[kind]) target = vec(GEN[kind], S);
        else if (VECK[kind]) target = vec(VECK[kind], V);
        else if (SCALK[kind]) target = scalar(SCALK[kind]);
        else if (kind === 'm') { if (!t.mat) { ok = false; break; } M = t; targets.push(t); continue; }
        else target = typeFromName(kind, null);
        const c = convCost(t, target);
        if (c < 0) { ok = false; break; }
        cost += c;
        targets.push(target);
      }
      if (!ok) continue;
      let ret;
      const r = sig.ret;
      if (GEN[r]) ret = vec(GEN[r], S);
      else if (VECK[r]) ret = vec(VECK[r], V);
      else if (SCALK[r]) ret = scalar(SCALK[r]);
      else if (r === 'm') ret = M;
      else if (r === 'mT') ret = M ? mat(M.rows, M.cols) : null;
      else if (r === 'mO') ret = ts[0] && ts[1] ? mat(ts[1].n, ts[0].n) : null;
      else ret = typeFromName(r, null);
      return { cost, targets, ret };
    }
    return null;
  }

  function resolveSigs(sigs, ts) {
    let best = null;
    for (const sig of sigs) {
      const m = matchSig(sig, ts);
      if (m && (!best || m.cost < best.cost)) best = m;
    }
    return best;
  }

  // ------------------------------------------------------------------ typing
  class Scope {
    constructor(parent) { this.parent = parent; this.vars = new Map(); }
    lookup(name) {
      for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
      const builtin = BUILTIN_VARS.get(name);
      return builtin ? { t: builtin, emit: name === 'gl_ViewportIndex' ? VIEWPORT_INDEX : name } : null;
    }
    declare(name, type, emit) { this.vars.set(name, { t: type, emit: emit || name }); }
  }

  // Globals and functions may not reuse a builtin function name under GLSL ES so those move aside
  const collides = (name) => BUILTINS.has(name) || TEXTURE_FUNCS.has(name);
  const aside = (name) => (collides(name) ? name + '_we' : name);

  function numType(text) {
    if (/^0[xX]/.test(text)) return scalar(/[uU]$/.test(text) ? 'uint' : 'int');
    if (/[uU]$/.test(text)) return scalar('uint');
    if (/[.eEfF]/.test(text)) return scalar('float');
    return scalar('int');
  }

  function floatLiteral(text, line) {
    const v = numberValue(text, line);
    const s = String(v);
    return /[.eE]/.test(s) ? s : s + '.0';
  }

  function literalCast(node, toB, line) {
    const inner = node.k === 'un' && (node.op === '-' || node.op === '+') ? node.e : node;
    if (inner.k !== 'num') return null;
    const from = numType(inner.v).b;
    let text = null;
    if (toB === 'float') text = from === 'float' ? inner.v : floatLiteral(inner.v, line);
    else if (toB === 'int' || toB === 'uint') {
      const v = numberValue(inner.v, line);
      if (!Number.isInteger(v)) return null;
      text = String(v) + (toB === 'uint' ? 'u' : '');
    }
    if (text === null) return null;
    const lit = { k: 'num', v: text, line, t: scalar(toB) };
    return inner === node ? lit : { k: 'un', op: node.op, e: lit, line, t: scalar(toB) };
  }

  function ctor(name, args, line, t) { return { k: 'call', name, dims: [], args, ctor: true, line, t }; }

  // Spells out an HLSL implicit conversion and leaves shapes HLSL refuses for the compiler to report
  function coerce(node, to) {
    const from = node.t;
    if (!from || !to || same(from, to)) return node;
    if (!isNumeric(from) || !isNumeric(to)) return node;
    if (to.n === 1) {
      if (from.n > 1) node = { k: 'mem', e: node, name: 'x', line: node.line, t: scalar(from.b) };
      if (node.t.b === to.b) return node;
      return literalCast(node, to.b, node.line) || ctor(to.b, [node], node.line, to);
    }
    if (from.n === 1) return ctor(typeName(to), [node], node.line, to);
    if (from.n < to.n) return node;
    if (from.n > to.n) node = { k: 'mem', e: node, name: 'xyzw'.slice(0, to.n), line: node.line, t: vec(from.b, to.n) };
    if (node.t.b !== to.b) node = ctor(typeName(to), [node], node.line, to);
    return node;
  }

  const toBool = (node) => (node.t && isNumeric(node.t) && node.t.n === 1 && node.t.b !== 'bool' ? ctor('bool', [node], node.line, scalar('bool')) : node);

  const COMPARE_FUNCS = { '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual' };

  class Typer {
    constructor(stage, linked) {
      this.stage = stage;
      this.linked = linked;
      this.structs = new Map();
      this.funcs = new Map();
      this.global = new Scope(null);
      this.fn = null;
      this.samplers = new Set();
      this.hoisted = [];
      this.sawMain = false;
    }

    // Whether GLSL ES accepts the expression where a constant expression is required
    isConstant(e, scope) {
      switch (e.k) {
        case 'num': case 'bool': case 'len': return true;
        case 'id': { const v = scope.lookup(e.name); return !!v && !!v.constant; }
        case 'un': case 'post': return this.isConstant(e.e, scope);
        case 'bin': case 'seq': return this.isConstant(e.l, scope) && this.isConstant(e.r, scope);
        case 'cond': return this.isConstant(e.c, scope) && this.isConstant(e.a, scope) && this.isConstant(e.b, scope);
        case 'idx': return this.isConstant(e.e, scope) && this.isConstant(e.i, scope);
        case 'mem': return this.isConstant(e.e, scope);
        case 'call': return (e.ctor || (BUILTINS.has(e.name) && !this.funcs.has(e.name))) && e.args.every((a) => this.isConstant(a, scope));
        default: return false;
      }
    }

    resolveType(name, dims, line) {
      let t = typeFromName(name, this.structs);
      if (t && t.sampler) this.samplers.add(t.sampler);
      for (let i = dims.length - 1; i >= 0; i--) {
        const d = dims[i];
        const size = d && d.k === 'num' ? numberValue(d.v, line) : null;
        t = t ? { arr: t, size } : null;
      }
      return t;
    }

    unit(items) {
      const out = [];
      for (const item of items) {
        if (item.k === 'precision' || item.k === 'raw') { out.push(item); continue; }
        if (item.k === 'func') { out.push(this.func(item)); continue; }
        const d = this.decl(item, this.global, true);
        if (d) out.push(d);
      }
      if (this.hoisted.length && !this.sawMain) fail(this.hoisted[0].line, 'the initializer of ' + this.hoisted[0].name + ' is not constant and there is no main() to run it in');
      return out;
    }

    registerStruct(struct) {
      const fields = new Map();
      for (const f of struct.fields) fields.set(f.name, this.resolveType(f.type, f.dims, struct.line));
      this.structs.set(struct.name, { struct: struct.name, fields });
    }

    decl(d, scope, global) {
      if (d.struct) this.registerStruct(d.struct);
      let quals = d.quals.filter((q) => q !== 'static' && (global || q !== 'const'));
      let typeNameText = d.type;
      let base = this.resolveType(d.type, d.dims, d.line);
      const io = quals.includes(this.stage === 'vertex' ? 'out' : 'in');
      const plain = global && !quals.includes('uniform') && !quals.includes('in') && !quals.includes('out');
      // A fragment input takes the wider type of the vertex output as Wallpaper Engine links them
      if (global && io && this.stage === 'fragment' && d.declarators.length === 1 && this.linked[d.declarators[0].name]) {
        const lt = typeFromName(this.linked[d.declarators[0].name], null);
        if (lt && base && isNumeric(lt) && isNumeric(base) && lt.b === base.b && lt.n > base.n) { base = lt; typeNameText = typeName(lt); }
      }
      const declarators = [];
      for (const v of d.declarators) {
        if (global && /^gl_/.test(v.name)) continue;
        let t = base;
        // A uniform a shader and an included module both declare is kept once
        if (global && quals.includes('uniform') && scope.vars.has(v.name) && same(scope.vars.get(v.name).t, t)) continue;
        for (let i = v.dims.length - 1; i >= 0; i--) {
          const dim = v.dims[i];
          t = t ? { arr: t, size: dim && dim.k === 'num' ? numberValue(dim.v, v.line) : null } : null;
        }
        let init = null;
        let dims = v.dims;
        if (v.init) {
          init = this.initializer(v.init, t, scope, d.type);
          if (dims.length && dims[dims.length - 1] === null && init.t && init.t.arr) {
            dims = dims.slice();
            dims[dims.length - 1] = { k: 'num', v: String(init.t.size), line: v.line, t: scalar('int') };
          }
        }
        const emit = global && !quals.includes('uniform') ? aside(v.name) : v.name;
        const constant = init !== null && this.isConstant(init, scope);
        // Non constant global initializers run first thing in main since GLSL ES rejects them here
        if (plain && init && !constant) {
          this.hoisted.push({ name: emit, init, t, line: v.line });
          init = null;
          quals = quals.filter((q) => q !== 'const');
        }
        scope.declare(v.name, t, emit);
        scope.vars.get(v.name).constant = global && quals.includes('const') && constant;
        declarators.push({ name: emit, dims, init, line: v.line });
      }
      if (!declarators.length && !d.struct) return null;
      if (global && io && base && isNumeric(base) && (base.b === 'int' || base.b === 'uint') && !quals.includes('flat')) quals.unshift('flat');
      return { k: 'decl', quals, type: typeNameText, dims: d.dims.map((e) => (e ? this.expr(e, scope) : e)), declarators, struct: d.struct, line: d.line };
    }

    // Brace lists become the constructor GLSL spells for the declared type
    initializer(init, t, scope, typeNameText) {
      if (init.k !== 'init') return coerce(this.expr(init, scope), t);
      const items = init.items.map((it) => {
        if (t && t.arr) return this.initializer(it, t.arr, scope, typeName(t.arr));
        if (t && t.struct) return this.initializer(it, null, scope, null);
        return this.initializer(it, t && isNumeric(t) ? scalar(t.b) : null, scope, null);
      });
      if (t && t.struct) {
        const fields = [...t.fields.values()];
        items.forEach((it, i) => { items[i] = coerce(it, fields[i] || null); });
      }
      if (t && t.arr) return { k: 'call', name: typeName(t.arr), dims: [{ k: 'num', v: String(items.length), line: init.line, t: scalar('int') }], args: items, ctor: true, line: init.line, t: { arr: t.arr, size: items.length } };
      return ctor(t ? typeName(t) : typeNameText, items, init.line, t);
    }

    func(f) {
      const ret = this.resolveType(f.type, f.dims, f.line);
      const params = f.params.map((p) => ({ quals: p.quals, type: p.type, dims: p.dims, name: p.name, t: this.resolveType(p.type, p.dims, f.line), out: p.quals.includes('out') || p.quals.includes('inout') }));
      if (!this.funcs.has(f.name)) this.funcs.set(f.name, []);
      const sigs = this.funcs.get(f.name);
      const emit = aside(f.name);
      if (!sigs.some((s) => s.params.length === params.length && s.params.every((p, i) => same(p.t, params[i].t)))) sigs.push({ params, ret, emit });
      if (!f.body) return { k: 'func', quals: f.quals, type: f.type, dims: f.dims, name: emit, params, body: null, line: f.line };
      const scope = new Scope(this.global);
      for (const p of params) if (p.name) scope.declare(p.name, p.t);
      const saved = this.fn;
      this.fn = { ret };
      const body = this.block(f.body, scope);
      this.fn = saved;
      if (f.name === 'main') {
        this.sawMain = true;
        const assigns = this.hoisted.map((h) => ({ k: 'expr', e: { k: 'asg', op: '=', l: { k: 'id', name: h.name, line: h.line, t: h.t }, r: h.init, line: h.line, t: h.t }, line: h.line }));
        body.stmts.unshift(...assigns);
      }
      return { k: 'func', quals: f.quals, type: f.type, dims: f.dims, name: emit, params, body, line: f.line };
    }

    block(b, scope) {
      const inner = new Scope(scope);
      return { k: 'block', stmts: b.stmts.map((s) => this.stmt(s, inner)).filter((s) => s), line: b.line };
    }

    // HLSL clip(x) discards the fragment when any component of x is negative
    clip(call, scope) {
      const x = this.expr(call.args[0], scope);
      const zero = { k: 'num', v: '0.0', line: call.line, t: scalar('float') };
      const c = x.t && isNumeric(x.t) && x.t.n > 1
        ? { k: 'call', name: 'any', args: [{ k: 'call', name: 'lessThan', args: [coerce(x, vec('float', x.t.n)), ctor(typeName(vec('float', x.t.n)), [zero], call.line, vec('float', x.t.n))], line: call.line, t: vec('bool', x.t.n) }], line: call.line, t: scalar('bool') }
        : { k: 'bin', op: '<', l: coerce(x, scalar('float')), r: zero, line: call.line, t: scalar('bool') };
      return { k: 'if', c, a: { k: 'discard', line: call.line }, b: null, line: call.line };
    }

    stmt(s, scope) {
      switch (s.k) {
        case 'block': return this.block(s, scope);
        case 'decl': return this.decl(s, scope, false);
        case 'expr':
          if (s.e.k === 'call' && !s.e.ctor && s.e.name === 'clip' && s.e.args.length === 1 && !this.funcs.has('clip')) return this.clip(s.e, scope);
          return { k: 'expr', e: this.expr(s.e, scope), line: s.line };
        case 'if': return { k: 'if', c: toBool(this.expr(s.c, scope)), a: this.stmt(s.a, scope), b: s.b ? this.stmt(s.b, scope) : null, line: s.line };
        case 'for': {
          const inner = new Scope(scope);
          const init = s.init ? this.stmt(s.init, inner) : null;
          const c = s.c ? toBool(this.expr(s.c, inner)) : null;
          const step = s.step ? this.expr(s.step, inner) : null;
          return { k: 'for', init, c, step, body: this.stmt(s.body, inner), line: s.line };
        }
        case 'while': return { k: 'while', c: toBool(this.expr(s.c, scope)), body: this.stmt(s.body, scope), line: s.line };
        case 'do': return { k: 'do', c: toBool(this.expr(s.c, scope)), body: this.stmt(s.body, scope), line: s.line };
        case 'switch': {
          const e = this.expr(s.e, scope);
          const inner = new Scope(scope);
          const cases = s.cases.map((c) => ({ label: c.label ? coerce(this.expr(c.label, inner), e.t) : null, stmts: c.stmts.map((x) => this.stmt(x, inner)).filter((x) => x), line: c.line }));
          return { k: 'switch', e, cases, line: s.line };
        }
        case 'return': {
          if (!s.e) return s;
          const e = this.expr(s.e, scope);
          return { k: 'return', e: this.fn ? coerce(e, this.fn.ret) : e, line: s.line };
        }
        default:
          return s;
      }
    }

    expr(e, scope) {
      switch (e.k) {
        case 'num': return { k: 'num', v: e.v, line: e.line, t: numType(e.v) };
        case 'bool': return { k: 'bool', v: e.v, line: e.line, t: scalar('bool') };
        case 'id': { const v = scope.lookup(e.name); return { k: 'id', name: v ? v.emit : e.name, line: e.line, t: v ? v.t : null }; }
        case 'seq': { const l = this.expr(e.l, scope); const r = this.expr(e.r, scope); return { k: 'seq', l, r, line: e.line, t: r.t }; }
        case 'un': return this.unary(e, scope);
        case 'post': { const x = this.expr(e.e, scope); return { k: 'post', op: e.op, e: x, line: e.line, t: x.t }; }
        case 'bin': return this.binary(e, scope);
        case 'asg': return this.assign(e, scope);
        case 'cond': return this.conditional(e, scope);
        case 'call': return this.call(e, scope);
        case 'idx': return this.index(e, scope);
        case 'mem': return this.member(e, scope);
        case 'len': { const x = this.expr(e.e, scope); return { k: 'len', e: x, line: e.line, t: scalar('int') }; }
        case 'init': fail(e.line, 'a brace initializer needs a declared type');
        // falls through
        default: fail(e.line, 'cannot type expression ' + e.k);
      }
      return null;
    }

    unary(e, scope) {
      let x = this.expr(e.e, scope);
      if (e.op === '!') { x = toBool(x); return { k: 'un', op: '!', e: x, line: e.line, t: scalar('bool') }; }
      let t = x.t;
      if ((e.op === '-' || e.op === '+') && t && isNumeric(t) && t.b === 'bool') { x = coerce(x, vec('int', t.n)); t = x.t; }
      return { k: 'un', op: e.op, e: x, line: e.line, t };
    }

    binary(e, scope) {
      const op = e.op;
      let l = this.expr(e.l, scope);
      let r = this.expr(e.r, scope);
      const lt = l.t;
      const rt = r.t;
      if (op === '&&' || op === '||' || op === '^^') return { k: 'bin', op, l: toBool(l), r: toBool(r), line: e.line, t: scalar('bool') };
      if (!lt || !rt) return { k: 'bin', op, l, r, line: e.line, t: null };
      if (op === '<<' || op === '>>') return { k: 'bin', op, l, r, line: e.line, t: lt };
      if (op === '==' || op === '!=') {
        if (isNumeric(lt) && isNumeric(rt)) {
          const b = wider(lt.b, rt.b);
          const n = Math.min(lt.n, rt.n);
          l = coerce(l, vec(b, n));
          r = coerce(r, vec(b, n));
        }
        return { k: 'bin', op, l, r, line: e.line, t: scalar('bool') };
      }
      if (op in COMPARE_FUNCS) {
        if (!isNumeric(lt) || !isNumeric(rt)) return { k: 'bin', op, l, r, line: e.line, t: scalar('bool') };
        const b = wider(lt.b, rt.b);
        if (lt.n === 1 && rt.n === 1) return { k: 'bin', op, l: coerce(l, scalar(b)), r: coerce(r, scalar(b)), line: e.line, t: scalar('bool') };
        const n = lt.n === 1 ? rt.n : rt.n === 1 ? lt.n : Math.min(lt.n, rt.n);
        return { k: 'call', name: COMPARE_FUNCS[op], args: [coerce(l, vec(b, n)), coerce(r, vec(b, n))], line: e.line, t: vec('bool', n) };
      }
      if (lt.mat || rt.mat) return this.matrixArith(op, l, r, e.line);
      if (!isNumeric(lt) || !isNumeric(rt)) return { k: 'bin', op, l, r, line: e.line, t: null };
      let b = wider(lt.b, rt.b);
      if (b === 'bool') b = 'int';
      if (op === '%' && b === 'float') {
        // Float modulo keeps the dividend sign under HLSL so fmod is spelled out instead of mod
        const n = lt.n === 1 ? rt.n : rt.n === 1 ? lt.n : Math.min(lt.n, rt.n);
        const t = vec('float', n);
        const a = coerce(l, lt.n === 1 ? scalar('float') : t);
        const c = coerce(r, rt.n === 1 ? scalar('float') : t);
        const div = { k: 'bin', op: '/', l: a, r: c, line: e.line, t };
        const tr = { k: 'call', name: 'trunc', args: [div], line: e.line, t };
        const mul = { k: 'bin', op: '*', l: c, r: tr, line: e.line, t };
        return { k: 'bin', op: '-', l: a, r: mul, line: e.line, t };
      }
      if ((op === '&' || op === '|' || op === '^' || op === '%') && b === 'float') return { k: 'bin', op, l, r, line: e.line, t: null };
      const n = lt.n === 1 ? rt.n : rt.n === 1 ? lt.n : Math.min(lt.n, rt.n);
      l = coerce(l, lt.n === 1 ? scalar(b) : vec(b, n));
      r = coerce(r, rt.n === 1 ? scalar(b) : vec(b, n));
      return { k: 'bin', op, l, r, line: e.line, t: vec(b, n) };
    }

    matrixArith(op, l, r, line) {
      const lt = l.t;
      const rt = r.t;
      const node = (t, a, c) => ({ k: 'bin', op, l: a, r: c, line, t });
      if (lt.mat && rt.mat) {
        if (op === '*') return node(lt.cols === rt.rows ? mat(rt.cols, lt.rows) : null, l, r);
        return node(same(lt, rt) ? lt : null, l, r);
      }
      if (lt.mat) {
        if (!isNumeric(rt)) return node(null, l, r);
        if (rt.n === 1) return node(lt, l, coerce(r, scalar('float')));
        if (op === '*') return node(vec('float', lt.rows), l, coerce(r, vec('float', lt.cols)));
        return node(null, l, r);
      }
      if (!isNumeric(lt)) return node(null, l, r);
      if (lt.n === 1) return node(rt, coerce(l, scalar('float')), r);
      if (op === '*') return node(vec('float', rt.cols), coerce(l, vec('float', rt.rows)), r);
      return node(null, l, r);
    }

    assign(e, scope) {
      const l = this.expr(e.l, scope);
      const r = this.expr(e.r, scope);
      if (e.op === '=') return { k: 'asg', op: '=', l, r: coerce(r, l.t), line: e.line, t: l.t };
      const op = e.op.slice(0, -1);
      const combined = this.binary({ k: 'bin', op, l: e.l, r: e.r, line: e.line }, scope);
      if (!l.t || !combined.t) return { k: 'asg', op: e.op, l, r, line: e.line, t: l.t };
      if (same(combined.t, l.t) && combined.k === 'bin' && same(combined.l.t, l.t)) return { k: 'asg', op: e.op, l, r: combined.r, line: e.line, t: l.t };
      if (!simpleLvalue(l)) fail(e.line, 'cannot translate ' + e.op + ' on a ' + typeName(l.t) + ' with a ' + typeName(combined.t) + ' operand');
      return { k: 'asg', op: '=', l, r: coerce(combined, l.t), line: e.line, t: l.t };
    }

    conditional(e, scope) {
      const c = toBool(this.expr(e.c, scope));
      let a = this.expr(e.a, scope);
      let b = this.expr(e.b, scope);
      let t = a.t;
      if (a.t && b.t && isNumeric(a.t) && isNumeric(b.t) && !same(a.t, b.t)) {
        t = vec(wider(a.t.b, b.t.b), Math.max(a.t.n, b.t.n));
        a = coerce(a, t);
        b = coerce(b, t);
      }
      return { k: 'cond', c, a, b, line: e.line, t };
    }

    call(e, scope) {
      const args = e.args.map((a) => this.expr(a, scope));
      if (e.ctor) {
        let t = typeFromName(e.name, this.structs);
        const dims = e.dims.map((d) => (d ? this.expr(d, scope) : d));
        if (e.dims.length) {
          const size = dims[0] ? numberValue(dims[0].v, e.line) : args.length;
          if (!dims[0]) dims[0] = { k: 'num', v: String(size), line: e.line, t: scalar('int') };
          t = t ? { arr: t, size } : null;
          if (t) args.forEach((a, i) => { args[i] = coerce(a, t.arr); });
        } else if (t && t.struct) {
          const fields = [...t.fields.values()];
          args.forEach((a, i) => { args[i] = coerce(a, fields[i] || null); });
        }
        return { k: 'call', name: e.name, dims, args, ctor: true, line: e.line, t };
      }
      const ts = args.map((a) => a.t);
      const user = this.funcs.get(e.name);
      if (user) {
        const r = this.resolveUser(user, ts);
        if (r) {
          r.sig.params.forEach((p, i) => { if (!p.out) args[i] = coerce(args[i], p.t); });
          return { k: 'call', name: r.sig.emit, args, line: e.line, t: r.sig.ret };
        }
      }
      if ((e.name === 'texLoad2D' || e.name === 'texSample2DBackBuffer') && args.length === 3) return this.texelLoad(e, args);
      if (TEXTURE_FUNCS.has(e.name)) return this.textureCall(e, args);
      const sigs = BUILTINS.get(e.name);
      if (sigs) {
        const m = resolveSigs(sigs, ts);
        if (m) {
          m.targets.forEach((t, i) => { if (t && e.name !== 'modf') args[i] = coerce(args[i], t); });
          return { k: 'call', name: e.name, args, line: e.line, t: m.ret };
        }
      }
      return { k: 'call', name: e.name, args, line: e.line, t: null };
    }

    resolveUser(sigs, ts) {
      let best = null;
      for (const sig of sigs) {
        if (sig.params.length !== ts.length) continue;
        let cost = 0;
        let ok = true;
        for (let i = 0; i < ts.length && ok; i++) {
          const p = sig.params[i];
          if (!ts[i] || !p.t) continue;
          const c = p.out ? (same(ts[i], p.t) ? 0 : -1) : convCost(ts[i], p.t);
          if (c < 0) ok = false;
          else cost += c;
        }
        if (ok && (!best || cost < best.cost)) best = { sig, cost };
      }
      return best;
    }

    // Wallpaper Engine loads at uv times resolution, which is the texel the fragment covers
    texelLoad(e, args) {
      const uv = coerce(args[1], vec('float', 2));
      const res = coerce(args[2], vec('float', 2));
      const pixel = { k: 'bin', op: '*', l: uv, r: res, line: e.line, t: vec('float', 2) };
      const fetch = { k: 'call', name: 'texelFetch', args: [args[0], ctor('ivec2', [pixel], e.line, vec('int', 2)), { k: 'num', v: '0', line: e.line, t: scalar('int') }], line: e.line };
      return this.textureCall(fetch, fetch.args);
    }

    textureCall(e, args) {
      const s = args[0] && args[0].t && args[0].t.sampler ? SAMPLERS[args[0].t.sampler] : null;
      if (!s) return { k: 'call', name: e.name, args, line: e.line, t: null };
      const name = e.name;
      const texel = s.shadow ? scalar('float') : vec(s.texel, 4);
      if (name === 'textureSize') {
        if (args[1]) args[1] = coerce(args[1], scalar('int'));
        return { k: 'call', name, args, line: e.line, t: vec('int', s.dim) };
      }
      if (name === 'texelFetch' || name === 'texelFetchOffset') {
        if (args[1]) args[1] = coerce(args[1], vec('int', s.dim));
        if (args[2]) args[2] = coerce(args[2], scalar('int'));
        return { k: 'call', name, args, line: e.line, t: texel };
      }
      const proj = /Proj/.test(name);
      for (let i = 1; i < args.length; i++) {
        const t = args[i].t;
        if (!t || !isNumeric(t) || t.b === 'float') continue;
        if (t.b === 'int' && /Offset/.test(name) && i >= 2 && t.n === s.dim) continue;
        args[i] = coerce(args[i], vec('float', t.n));
      }
      if (args[1] && args[1].t && isNumeric(args[1].t) && args[1].t.n === 1) args[1] = coerce(args[1], vec('float', s.coord + (proj ? 1 : 0)));
      const widest = proj ? (s.coord === 2 ? 4 : s.coord + 1) : s.coord;
      if (args[1] && args[1].t && isNumeric(args[1].t) && args[1].t.n > widest) args[1] = coerce(args[1], vec('float', widest));
      return { k: 'call', name, args, line: e.line, t: texel };
    }

    index(e, scope) {
      const x = this.expr(e.e, scope);
      let i = this.expr(e.i, scope);
      if (i.t && isNumeric(i.t) && i.t.n === 1 && i.t.b === 'float') i = coerce(i, scalar('int'));
      const t = x.t;
      let rt = null;
      if (t) {
        if (t.arr) rt = t.arr;
        else if (t.mat) rt = vec('float', t.rows);
        else if (isNumeric(t) && t.n > 1) rt = scalar(t.b);
      }
      return { k: 'idx', e: x, i, line: e.line, t: rt };
    }

    member(e, scope) {
      const x = this.expr(e.e, scope);
      const t = x.t;
      if (!t) return { k: 'mem', e: x, name: e.name, line: e.line, t: null };
      if (t.struct) return { k: 'mem', e: x, name: e.name, line: e.line, t: t.fields.get(e.name) || null };
      if (!isNumeric(t) || !/^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(e.name)) return { k: 'mem', e: x, name: e.name, line: e.line, t: null };
      const n = e.name.length;
      if (t.n === 1) {
        // Scalar swizzles exist in HLSL and become constructors
        if (!/^(x+|r+|s+)$/.test(e.name)) return { k: 'mem', e: x, name: e.name, line: e.line, t: null };
        return n === 1 ? x : ctor(typeName(vec(t.b, n)), [x], e.line, vec(t.b, n));
      }
      return { k: 'mem', e: x, name: e.name, line: e.line, t: vec(t.b, n) };
    }
  }

  function simpleLvalue(e) {
    if (e.k === 'id') return true;
    if (e.k === 'mem') return simpleLvalue(e.e);
    if (e.k === 'idx') return simpleLvalue(e.e) && (e.i.k === 'num' || e.i.k === 'id' || (e.i.k === 'mem' && e.i.e.k === 'id'));
    return false;
  }

  // ---------------------------------------------------------------- emitting
  const PREC = { '||': 4, '^^': 5, '&&': 6, '|': 7, '^': 8, '&': 9, '==': 10, '!=': 10, '<': 11, '>': 11, '<=': 11, '>=': 11, '<<': 12, '>>': 12, '+': 13, '-': 13, '*': 14, '/': 14, '%': 14 };
  function precOf(e) {
    switch (e.k) {
      case 'seq': return 1;
      case 'asg': return 2;
      case 'cond': return 3;
      case 'bin': return PREC[e.op];
      case 'un': return 15;
      case 'post': case 'idx': case 'mem': case 'len': case 'call': return 16;
      default: return 17;
    }
  }

  function numText(v) {
    if (/^0[xX]/.test(v)) return v;
    if (/[uU]$/.test(v)) return v;
    if (!/[.eEfF]/.test(v)) return v;
    let s = v.replace(/[fF]$/, '');
    if (s[0] === '.') s = '0' + s;
    s = s.replace(/\.(?=[eE]|$)/, '.0');
    return s;
  }

  function emitExpr(e) {
    const wrap = (x, min) => (precOf(x) < min ? '(' + emitExpr(x) + ')' : emitExpr(x));
    switch (e.k) {
      case 'num': return numText(e.v);
      case 'bool': return e.v ? 'true' : 'false';
      case 'id': return e.name;
      case 'seq': return emitExpr(e.l) + ', ' + wrap(e.r, 2);
      case 'asg': return wrap(e.l, 16) + ' ' + e.op + ' ' + wrap(e.r, 2);
      case 'cond': return wrap(e.c, 4) + ' ? ' + wrap(e.a, 2) + ' : ' + wrap(e.b, 2);
      case 'bin': return wrap(e.l, PREC[e.op]) + ' ' + e.op + ' ' + wrap(e.r, PREC[e.op] + 1);
      case 'un': return e.op + (e.e.k === 'un' ? '(' + emitExpr(e.e) + ')' : wrap(e.e, 15));
      case 'post': return wrap(e.e, 16) + e.op;
      case 'idx': return wrap(e.e, 16) + '[' + emitExpr(e.i) + ']';
      case 'mem': return wrap(e.e, 16) + '.' + e.name;
      case 'len': return wrap(e.e, 16) + '.length()';
      case 'call': return e.name + (e.dims || []).map((d) => '[' + (d ? emitExpr(d) : '') + ']').join('') + '(' + e.args.map(emitExpr).join(', ') + ')';
      default: fail(e.line, 'cannot emit expression ' + e.k);
    }
    return '';
  }

  const emitDims = (dims) => dims.map((d) => '[' + (d ? emitExpr(d) : '') + ']').join('');

  function emitDecl(d) {
    let s = d.quals.length ? d.quals.join(' ') + ' ' : '';
    if (d.struct) {
      s += 'struct ' + d.struct.name + ' {\n';
      for (const f of d.struct.fields) s += '  ' + (f.quals.length ? f.quals.join(' ') + ' ' : '') + f.type + ' ' + f.name + emitDims(f.dims) + ';\n';
      s += '}';
      if (d.declarators.length) s += ' ';
    } else {
      s += d.type + emitDims(d.dims);
      if (d.declarators.length) s += ' ';
    }
    s += d.declarators.map((v) => v.name + emitDims(v.dims) + (v.init ? ' = ' + emitExpr(v.init) : '')).join(', ');
    return s + ';';
  }

  function emitStmt(s, indent) {
    const pad = '  '.repeat(indent);
    const sub = (x) => (x.k === 'block' ? emitBlock(x, indent) : emitStmt(x, indent + 1));
    switch (s.k) {
      case 'block': return emitBlock(s, indent);
      case 'empty': return pad + ';';
      case 'decl': return pad + emitDecl(s);
      case 'expr': return pad + emitExpr(s.e) + ';';
      case 'if': {
        let out = pad + 'if (' + emitExpr(s.c) + ')\n' + sub(s.a);
        if (s.b) out += '\n' + pad + 'else\n' + sub(s.b);
        return out;
      }
      case 'for': {
        const init = s.init ? (s.init.k === 'decl' ? emitDecl(s.init) : emitExpr(s.init.e) + ';') : ';';
        return pad + 'for (' + init + ' ' + (s.c ? emitExpr(s.c) : '') + '; ' + (s.step ? emitExpr(s.step) : '') + ')\n' + sub(s.body);
      }
      case 'while': return pad + 'while (' + emitExpr(s.c) + ')\n' + sub(s.body);
      case 'do': return pad + 'do\n' + sub(s.body) + '\n' + pad + 'while (' + emitExpr(s.c) + ');';
      case 'switch': {
        let out = pad + 'switch (' + emitExpr(s.e) + ') {\n';
        for (const c of s.cases) {
          out += pad + (c.label ? 'case ' + emitExpr(c.label) : 'default') + ':\n';
          for (const x of c.stmts) out += emitStmt(x, indent + 1) + '\n';
        }
        return out + pad + '}';
      }
      case 'return': return pad + 'return' + (s.e ? ' ' + emitExpr(s.e) : '') + ';';
      case 'break': case 'continue': case 'discard': return pad + s.k + ';';
      default: fail(s.line, 'cannot emit statement ' + s.k);
    }
    return '';
  }

  function emitBlock(b, indent) {
    const pad = '  '.repeat(indent);
    return pad + '{\n' + b.stmts.map((s) => emitStmt(s, indent + 1)).join('\n') + (b.stmts.length ? '\n' : '') + pad + '}';
  }

  function emitFunc(f) {
    const params = f.params.map((p) => (p.quals.length ? p.quals.join(' ') + ' ' : '') + p.type + (p.name ? ' ' + p.name : '') + emitDims(p.dims)).join(', ');
    const head = (f.quals.length ? f.quals.join(' ') + ' ' : '') + f.type + emitDims(f.dims) + ' ' + f.name + '(' + params + ')';
    return f.body ? head + '\n' + emitBlock(f.body, 0) : head + ';';
  }

  // Varyings only the vertex shader declares get a fragment declaration
  function declareLinkedInputs(items, tokens, linked) {
    const declared = new Set();
    for (const item of items) {
      if (item.k === 'func') declared.add(item.name);
      else if (item.k === 'decl') for (const d of item.declarators) declared.add(d.name);
    }
    const used = new Set(tokens.filter((t) => t.k === 'id').map((t) => t.v));
    for (const [name, type] of Object.entries(linked)) {
      if (declared.has(name) || !used.has(name)) continue;
      items.unshift({ k: 'decl', quals: ['in'], type, dims: [], declarators: [{ name, dims: [], init: null, line: 0 }], line: 0 });
    }
  }

  // Translates shader text whose includes were resolved for a stage named vertex or fragment
  function translate(text, stage, options) {
    const linked = (options && options.linkedOutputs) || {};
    const pre = preprocess(text);
    pre.tokens.push({ k: 'eof', v: EOF.v, line: pre.tokens.length ? pre.tokens[pre.tokens.length - 1].line : 0 });
    const parser = new Parser(pre.tokens);
    const items = parser.unit();
    if (stage === 'fragment') declareLinkedInputs(items, pre.tokens, linked);
    if (pre.tokens.some((t) => t.k === 'id' && t.v === 'gl_ViewportIndex')) items.unshift({ k: 'decl', quals: [], type: 'int', dims: [], declarators: [{ name: VIEWPORT_INDEX, dims: [], init: null, line: 0 }], line: 0 });
    const typer = new Typer(stage, linked);
    const typed = typer.unit(items);
    let out = pre.directives.map((d) => d + '\n').join('');
    out += 'precision highp float;\nprecision highp int;\n';
    for (const s of typer.samplers) out += 'precision highp ' + s + ';\n';
    for (const item of typed) {
      if (item.k === 'precision') out += 'precision ' + item.q + ' ' + item.type + ';\n';
      else if (item.k === 'raw') out += item.text + '\n';
      else if (item.k === 'func') out += emitFunc(item) + '\n';
      else out += emitDecl(item) + '\n';
    }
    return out;
  }

  const api = { translate, preprocess, TranslateError };
  G.WEGLSL = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
