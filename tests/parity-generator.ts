import { type SExpr, isList, opName } from '../src/ast.js';

type Kind = 'number' | 'string' | 'boolean' | 'list' | 'record' | 'value';
const KINDS: Kind[] = ['number', 'string', 'boolean', 'list', 'record', 'value'];
const TEXT = ['', 'hello', 'a/b?c#d', '%_\\', 'é🙂', 'a\nb', '${x}`', ': any as any', '{name}', '0', 'false', '\0', '\u2028', '\ud800'];

// GRHM accepts these escapes and literal Unicode; JSON's \\u syntax is not a
// source-language escape. Keep the generator independent of JSON spelling.
function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

/** Guaranteed boundaries complement the random distribution on every run. */
export const BOUNDARY_EXPRESSIONS = [
  '(> 2 1)', '(>= 2 2)', '-0', '(+ 0.1 0.2)', '(+ 9007199254740991 1)', '(to-num "1e309")', '(to-num "-1e309")', '(to-num "NaN")',
  '(to-num "")', '(to-num null)', '(to-num (obj))', '(to-num "abc")', '(to-num true)', '(+ 1 (to-num "x"))',
  '(to-fixed 2 (or-else (to-num "x") 0))', '(date-parse "")', '(date-parse "nope")',
  '(+ (arr 1 2) 3)', '(+ (obj :x 1) 2)', '(+ true null)',
  '(first "abc")', '(reverse "é🙂")', '(take 2 "abcd")', '(sum "123")', '(contains null "x")',
  '(map 1 (arr))', '(filter null (arr))', '(reduce false 0 (arr))',
  '(let ((record (obj :missing (first (arr)) :present null))) record)',
  '(get (obj :__proto__ (obj :hidden true)) "hidden")',
  '(get (obj :constructor "own" :toString "literal") "constructor")',
  '(let ((value (first (arr)))) (attempt value.name "missing"))',
  '(count (arr))', '(concat "")', '(- 3)', '(min 1)', '(max 1)', '(date-str 0)',
  `(path "/{id}" :id ${quote('\ud800')})`,
  `(fmt "{value}" :value ${quote('\0\u2028')})`,
  '(factorial 7)', '(call double 4)', '(match status.closed ("open" 1) ("closed" 2))',
  '(keys (obj :a 1 :b 2))', '(values (obj :a 1 :b "two"))', '(entries (obj :a 1))',
  '(from-entries (arr (arr "__proto__" 1) (arr "a" 2) (arr "a" 3)))',
  '(assoc (obj :a 1) "__proto__" (obj :safe true))', '(dissoc (obj :a 1 :b 2) "a")',
  '(merge (obj :a 1) (obj :a "last" :b 2))', '(has-key (obj) "toString")',
  '(json-parse "[1,null,true]")', '(json-stringify (obj :a (first (arr)) :b null))',
  '(flat-map (lambda (x) (arr x x)) (arr 1 2))', '(flatten (arr (arr 1 2) 3 null))',
  '(unique (arr 0 -0 (/ 0 0) (/ 0 0) 1 1))',
  '(zip (arr 1 2 3) (arr "a" "b"))', '(chunk 2 (arr 1 2 3))',
  '(group-by (lambda (x) (to-str (mod x 2))) (arr 1 2 3))',
  '(regex-test "^a" "ABC" "i")', '(regex-find "(a)?(b)" "b")',
  '(regex-replace "a" "x" "banana")', '(url-encode "a/b?c#d")', '(url-decode "a%2Fb")',
  '(date-iso 0)', '(date-parse "2000-01-01T00:00:00.000Z")', '(clamp 0 10 20)',
  '(trunc -1.9)', '(sign -0)', '(sin 0)', '(cos 0)', '(tan 0)', '(asin 1)', '(acos 1)',
  '(atan 1)', '(atan2 1 -1)', '(exp 0)', '(log 1)', '(log10 100)',
  '(keys null)', '(values 3)', '(entries "ab")', '(from-entries (arr 1))',
  '(dissoc null "x")', '(merge (obj) null)', '(has-key null "x")', '(json-parse "bad")',
  '(flat-map 3 (arr))', '(flatten null)', '(unique null)', '(zip null (arr 1))',
  '(chunk 0 (arr))', '(chunk 1.5 (arr 1))', '(chunk "2" (arr 1))',
  '(group-by 1 (arr))', '(group-by (lambda (x) "__proto__") (arr 1 2))', '(sort-by 1 (arr))',
  '(regex-test "[" "x")', '(regex-test "x" "x" "bad")', '(regex-find "x" "y")',
  '(regex-replace "(a)" "$1$1" "abc")', '(url-decode "%")', '(date-iso (/ 0 0))',
  '(let ((record (obj :x 1))) (unique (arr record record (obj :x 1))))',
];

/** Stable seed: failures can be replayed without a property-testing dependency. */
export function expressions(seed: number, count: number): string[] {
  let state = seed >>> 0;
  const random = (): number => {
    state += 0x6d2b79f5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const integer = (): string => String(Math.floor(random() * 17) - 8);
  const literal = (): string => pick([integer(), quote(pick(TEXT)), 'true', 'false', 'null']);
  const make = (kind: Kind, depth: number): string => {
    const number = () => make('number', depth - 1);
    const string = () => make('string', depth - 1);
    const boolean = () => make('boolean', depth - 1);
    const list = () => make('list', depth - 1);
    const value = () => make('value', depth - 1);
    if (depth <= 0) {
      switch (kind) {
        case 'number': return integer();
        case 'string': return quote(pick(TEXT));
        case 'boolean': return pick(['true', 'false']);
        case 'list': return `(arr ${Array.from({ length: Math.floor(random() * 4) }, literal).join(' ')})`;
        case 'record': return `(obj :value ${literal()} :name ${quote(pick(TEXT))})`;
        case 'value': return literal();
      }
    }
    // Cross-cutting constructs make nesting and lexical scope part of every
    // generated category rather than isolated hand-written examples.
    if (random() < 0.22) {
      const a = make(kind, depth - 1);
      const b = make(kind, depth - 1);
      return pick([
        `(if ${boolean()} ${a} ${b})`,
        `(cond (${boolean()} ${a}) (else ${b}))`,
        `(match ${integer()} (0 ${a}) (else ${b}))`,
        `(let ((value ${a})) (let ((value ${b})) value))`,
        `(let ((value ${a})) (let ((read-value (lambda () value)) (value ${b})) (call read-value)))`,
        `(attempt ${a} ${b})`,
      ]);
    }
    switch (kind) {
      case 'number': return pick([
        `(${pick(['+', '-', '*', '/', 'mod', 'min', 'max'])} ${number()} ${number()})`,
        `(${pick(['abs', 'round', 'floor', 'ceil', 'sqrt'])} ${number()})`,
        `(pow ${integer()} ${Math.floor(random() * 5)})`,
        `(to-num ${value()})`, `(count ${pick([list(), string(), 'null'])})`,
        `(sum ${list()})`, `(reduce (lambda (acc item) (+ acc (to-num item))) 0 ${list()})`,
        `(double ${number()})`,
        `(clamp -3 3 ${number()})`, `(${pick(['trunc', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log10'])} ${number()})`,
        `(atan2 ${number()} ${number()})`,
        `(let ((sum ${number()})) (+ sum (sum (arr 1 2))))`,
      ]);
      case 'string': return pick([
        `(${pick(['upper', 'lower', 'trim', 'to-str'])} ${value()})`,
        `(concat ${string()} ${value()} ${string()})`, `(join ${string()} ${list()})`,
        `(replace ${string()} ${string()} ${string()})`, `(to-fixed 2 ${number()})`,
        `(fmt "{name}/{value}/{name}" :name ${value()} :value ${value()})`,
        `(path "/items/{id}" :id ${value()})`, `(t hello :name ${value()})`,
        `(slice ${integer()} ${integer()} ${string()})`,
        `(json-stringify ${value()})`, `(url-encode ${string()})`, `(url-decode ${string()})`,
        `(regex-replace "a" ${string()} ${string()})`,
      ]);
      case 'boolean': return pick([
        `(${pick(['=', '!='])} ${value()} ${value()})`,
        `(${pick(['<', '<=', '>', '>='])} ${number()} ${number()})`,
        `(${pick(['and', 'or'])} ${value()} ${value()})`, `(not ${value()})`,
        `(regex-test "a" ${string()})`, `(has-key ${make('record', depth - 1)} "value")`,
        `(${pick(['is-null', 'not-null'])} ${value()})`,
        `(contains ${pick([string(), list()])} ${value()})`,
        `(${pick(['starts-with', 'ends-with'])} ${string()} ${string()})`,
        `(${pick(['some', 'every'])} (lambda (item) (not-null item)) ${list()})`,
      ]);
      case 'list': return pick([
        `(arr ${value()} ${value()})`, `(range -2 ${Math.floor(random() * 7)})`,
        `(split ${string()} ${string()})`, `(reverse ${list()})`,
        `(${pick(['take', 'drop'])} ${integer()} ${list()})`, `(append ${list()} ${value()})`,
        `(map (lambda (item) (to-str item)) ${list()})`,
        `(map (lambda (range) (+ (to-num range) (count (range 0 2)))) ${list()})`,
        `(filter (lambda (item) (not-null item)) ${list()})`,
        `(sort-by (lambda (item) (to-str item)) ${list()})`,
        `(unique ${list()})`, `(zip ${list()} ${list()})`, `(chunk 2 ${list()})`,
        `(flat-map (lambda (item) (arr item item)) ${list()})`, `(flatten ${list()})`,
        `(${pick(['keys', 'values', 'entries'])} ${make('record', depth - 1)})`,
        `(let ((factor ${number()})) (map (lambda (item) (+ factor (to-num item))) ${list()}))`,
      ]);
      case 'record': return `(obj :value ${value()} :label ${string()} :items ${list()})`;
      case 'value': return pick([
        make(pick(KINDS.filter((k) => k !== 'value')), depth - 1), 'null',
        `(${pick(['first', 'last'])} ${list()})`, `(nth ${integer()} ${list()})`,
        `(find (lambda (item) (not-null item)) ${list()})`,
        `(get ${make('record', depth - 1)} ${pick(['"value"', '"missing"', '"items"'])})`,
        `(or-else ${pick(['null', '(first (arr))', literal()])} ${value()})`,
        `(let ((record (first (arr)))) (attempt record.value ${value()}))`,
        `(match status.open ("open" ${value()}) (else ${value()}))`,
      ]);
    }
  };
  return Array.from({ length: count }, (_, index) => make(KINDS[index % KINDS.length]!, 3));
}

export function serialize(expr: SExpr): string {
  switch (expr.kind) {
    case 'list': return '(' + expr.items.map(serialize).join(' ') + ')';
    case 'ident': return expr.name;
    case 'keyword': return ':' + expr.name;
    case 'string': return quote(expr.value);
    case 'number': return Object.is(expr.value, -0) ? '-0' : String(expr.value);
    case 'boolean': return String(expr.value);
    case 'null': return 'null';
  }
}

/** Expression positions only: keep parameter lists, patterns and arities intact. */
function childPaths(expr: SExpr): number[][] {
  if (!isList(expr)) return [];
  const op = opName(expr);
  if (op === 'lambda') return expr.items[2] === undefined ? [] : [[2]];
  if (op === 'let') {
    const bindings = expr.items[1];
    const paths: number[][] = expr.items[2] === undefined ? [] : [[2]];
    if (bindings !== undefined && isList(bindings)) bindings.items.forEach((pair, i) => {
      if (isList(pair) && pair.items[1] !== undefined) paths.push([1, i, 1]);
    });
    return paths;
  }
  if (op === 'cond' || op === 'match') {
    const paths: number[][] = op === 'match' ? [[1]] : [];
    expr.items.forEach((clause, i) => {
      if (i < (op === 'match' ? 2 : 1) || !isList(clause)) return;
      if (op === 'cond' && clause.items[0]?.kind !== 'ident') paths.push([i, 0]);
      if (clause.items[1] !== undefined) paths.push([i, 1]);
    });
    return paths;
  }
  return expr.items.flatMap((item, i) => {
    if (i === 0 || item.kind === 'keyword' || (op === 'call' && i === 1) || (op === 't' && i === 1)) return [];
    // Templates must remain literal strings.
    if ((op === 'fmt' || op === 'path') && i === 1) return [];
    return [[i]];
  });
}

function at(expr: SExpr, indices: number[]): SExpr {
  let result = expr;
  for (const index of indices) {
    if (!isList(result) || result.items[index] === undefined) throw new Error('invalid shrink path');
    result = result.items[index]!;
  }
  return result;
}

function replaceAt(expr: SExpr, indices: number[], replacement: SExpr): SExpr {
  if (indices.length === 0) return replacement;
  if (!isList(expr)) throw new Error('invalid shrink path');
  const [index, ...rest] = indices;
  return { ...expr, items: expr.items.map((item, i) => i === index ? replaceAt(item, rest, replacement) : item) };
}

function candidates(expr: SExpr): SExpr[] {
  const simple: SExpr[] = [
    { kind: 'number', value: 0, span: expr.span },
    { kind: 'string', value: '', span: expr.span },
    { kind: 'null', span: expr.span },
    { kind: 'boolean', value: false, span: expr.span },
  ];
  if (expr.kind === 'string' && expr.value.length > 1) simple.push({ ...expr, value: expr.value.slice(0, Math.floor(expr.value.length / 2)) });
  for (const indices of childPaths(expr)) {
    const child = at(expr, indices);
    simple.push(child);
    for (const replacement of candidates(child)) simple.push(replaceAt(expr, indices, replacement));
  }
  return simple.filter((candidate) => serialize(candidate).length < serialize(expr).length);
}

/** Greedy structural shrinking with an explicit evaluation budget. */
export async function minimize(expr: SExpr, fails: (candidate: SExpr) => Promise<boolean>, budget = 200): Promise<SExpr> {
  let current = expr;
  const seen = new Set<string>();
  while (budget > 0) {
    let improved = false;
    for (const candidate of candidates(current)) {
      const source = serialize(candidate);
      if (seen.has(source)) continue;
      seen.add(source);
      budget -= 1;
      if (await fails(candidate)) { current = candidate; improved = true; break; }
      if (budget <= 0) break;
    }
    if (!improved) break;
  }
  return current;
}
