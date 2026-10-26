/**
 * Safe math expression parser/evaluator. No eval(), no Function(): input is tokenised and parsed into
 * an AST that only supports arithmetic, a fixed set of functions, and absolute value.
 */
export type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'fn'; name: string; a: Node };

export class MathParseError extends Error {}

const FUNCS = new Set(['sqrt', 'abs']);
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function normalizeMathText(s: string): string {
  return s
    .replace(/[−–—]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/√/g, 'sqrt').replace(/π/g, 'pi')
    .replace(/ /g, ' ');
}

type Tok = { k: 'num' | 'id' | 'op' | 'lp' | 'rp' | 'bar'; s: string };

function tokenize(src: string): Tok[] {
  const s = normalizeMathText(src);
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const txt = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(txt)) throw new MathParseError(`bad number "${txt}"`);
      out.push({ k: 'num', s: txt }); i = j; continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i; while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      let word = s.slice(i, j).toLowerCase();
      // split unknown multi-letter words into single-letter variables (e.g. "xy" -> x*y); keep known names
      const emit = (w: string) => {
        if (FUNCS.has(w) || w in CONSTS) out.push({ k: 'id', s: w });
        else for (const ch of w) out.push({ k: 'id', s: ch });
      };
      // peel known function/const names out of longer runs ("2sqrt" handled by regexp below)
      while (word.length) {
        const m = /^(sqrt|abs|pi)/.exec(word);
        if (m) { emit(m[1]); word = word.slice(m[1].length); }
        else { const nxt = word.search(/sqrt|abs|pi/); const part = nxt < 0 ? word : word.slice(0, nxt); emit(part); word = word.slice(part.length); }
      }
      i = j; continue;
    }
    if ('+-*/^'.includes(c)) { out.push({ k: 'op', s: c }); i++; continue; }
    if (c === '(' || c === '[') { out.push({ k: 'lp', s: '(' }); i++; continue; }
    if (c === ')' || c === ']') { out.push({ k: 'rp', s: ')' }); i++; continue; }
    if (c === '|') { out.push({ k: 'bar', s: '|' }); i++; continue; }
    throw new MathParseError(`unexpected character "${c}"`);
  }
  return out;
}

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  let absDepth = 0;
  const peek = () => toks[p];

  function startsPrimary(t?: Tok) {
    if (!t) return false;
    if (t.k === 'num' || t.k === 'id' || t.k === 'lp') return true;
    if (t.k === 'bar') return absDepth === 0; // inside |...| a bar closes
    return false;
  }
  function expr(): Node {
    let a = term();
    while (peek() && peek().k === 'op' && (peek().s === '+' || peek().s === '-')) {
      const op = toks[p++].s as '+' | '-'; a = { t: 'bin', op, a, b: term() };
    }
    return a;
  }
  function term(): Node {
    let a = unary();
    for (;;) {
      const t = peek();
      if (t && t.k === 'op' && (t.s === '*' || t.s === '/')) { p++; a = { t: 'bin', op: t.s as '*' | '/', a, b: unary() }; }
      else if (startsPrimary(t)) a = { t: 'bin', op: '*', a, b: power() }; // implicit multiplication
      else return a;
    }
  }
  function unary(): Node {
    const t = peek();
    if (t && t.k === 'op' && (t.s === '-' || t.s === '+')) { p++; const a = unary(); return t.s === '-' ? { t: 'neg', a } : a; }
    return power();
  }
  function power(): Node {
    const base = primary();
    const t = peek();
    if (t && t.k === 'op' && t.s === '^') { p++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  }
  function primary(): Node {
    const t = toks[p++];
    if (!t) throw new MathParseError('unexpected end of expression');
    if (t.k === 'num') return { t: 'num', v: parseFloat(t.s) };
    if (t.k === 'id') {
      if (FUNCS.has(t.s)) {
        const nx = peek();
        if (!nx || nx.k !== 'lp') throw new MathParseError(`${t.s} needs parentheses`);
        p++; const save = absDepth; absDepth = 0; const a = expr(); absDepth = save;
        if (!peek() || peek().k !== 'rp') throw new MathParseError('missing )');
        p++; return { t: 'fn', name: t.s, a };
      }
      if (t.s in CONSTS) return { t: 'num', v: CONSTS[t.s] };
      return { t: 'var', name: t.s };
    }
    if (t.k === 'lp') {
      const save = absDepth; absDepth = 0; const a = expr(); absDepth = save;
      if (!peek() || peek().k !== 'rp') throw new MathParseError('missing )');
      p++; return a;
    }
    if (t.k === 'bar') {
      absDepth++; const a = expr(); absDepth--;
      if (!peek() || peek().k !== 'bar') throw new MathParseError('missing closing |');
      p++; return { t: 'fn', name: 'abs', a };
    }
    throw new MathParseError(`unexpected "${t.s}"`);
  }

  if (toks.length === 0) throw new MathParseError('empty expression');
  const n = expr();
  if (p < toks.length) throw new MathParseError(`unexpected "${toks[p].s}"`);
  return n;
}

export function evalNode(n: Node, env: Record<string, number>): number {
  switch (n.t) {
    case 'num': return n.v;
    case 'var': { const v = env[n.name]; if (v === undefined) throw new MathParseError(`unknown variable ${n.name}`); return v; }
    case 'neg': return -evalNode(n.a, env);
    case 'fn': { const a = evalNode(n.a, env); return n.name === 'abs' ? Math.abs(a) : Math.sqrt(a); }
    case 'bin': {
      const a = evalNode(n.a, env), b = evalNode(n.b, env);
      switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': return Math.pow(a, b); }
    }
  }
}

export function variablesOf(n: Node, acc = new Set<string>()): Set<string> {
  if (n.t === 'var') acc.add(n.name);
  else if (n.t === 'neg' || n.t === 'fn') variablesOf(n.a, acc);
  else if (n.t === 'bin') { variablesOf(n.a, acc); variablesOf(n.b, acc); }
  return acc;
}

/** Evaluate a variable-free expression, e.g. "3/4" or "sqrt(2)/2". */
export function evalConstant(src: string): number {
  const n = parseExpr(src);
  if (variablesOf(n).size) throw new MathParseError('expected a number');
  const v = evalNode(n, {});
  if (!Number.isFinite(v)) throw new MathParseError('not a finite number');
  return v;
}

/** Are two single-variable expressions equal at many deterministic sample points? */
export function expressionsEquivalent(a: string, b: string, variable = 'x'): boolean {
  const A = parseExpr(a), B = parseExpr(b);
  const vars = new Set([...variablesOf(A), ...variablesOf(B)]);
  const pts = [-7.3, -3.1, -1.7, -0.6, 0.4, 1.3, 2.9, 4.7, 9.1, 13.37];
  let compared = 0;
  for (let i = 0; i < pts.length; i++) {
    const env: Record<string, number> = {};
    let j = 0;
    for (const v of vars) env[v] = pts[(i + 3 * j++) % pts.length];
    if (vars.size === 0) env[variable] = 0;
    const va = evalNode(A, env), vb = evalNode(B, env);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue; // outside the domain of one side
    compared++;
    if (Math.abs(va - vb) > 1e-8 * Math.max(1, Math.abs(va), Math.abs(vb))) return false;
  }
  return compared >= 3;
}
