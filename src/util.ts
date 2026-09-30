/** Levenshtein distance, used for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(cur + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = cur;
    }
  }
  return dp[b.length] ?? 0;
}

export function nearest(name: string, candidates: Iterable<string>, maxDistance = 2): string | undefined {
  let best: string | undefined;
  let bestDist = maxDistance + 1;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// GRHM bindings are lowered to JavaScript identifiers. Keep the accepted
// source shape deliberately narrow enough that camelCase produces a valid
// identifier; generated-name collisions are checked separately by analysis.
const BINDING_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const JS_RESERVED_WORDS = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** Whether a GRHM binding name can be emitted as a JavaScript identifier. */
export function validBindingName(name: string): boolean {
  return BINDING_NAME_RE.test(name) && !JS_RESERVED_WORDS.has(camelCase(name));
}

/** Whether text can be emitted as an unquoted JavaScript identifier name. */
export function validJsIdentifier(name: string): boolean {
  return JS_IDENTIFIER_RE.test(name);
}

/**
 * Literal CSS values are emitted into generated declarations. Keep structural
 * syntax and URL-bearing values out of this declarative surface so a string
 * cannot terminate its declaration or smuggle an active external resource.
 */
export function isSafeCssLiteral(value: string): boolean {
  return value.trim() !== '' && !/[;{}\u0000-\u001f\u007f]/.test(value) && !/\/\*|\*\/|url\s*\(/i.test(value);
}

/** kebab-case (or dotted) name to camelCase JS identifier. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** kebab-case name to PascalCase component name. */
export function pascalCase(name: string): string {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A correlation marker whose user-controlled ID cannot escape its comment. */
export function sourceMarker(id: string | undefined): string {
  const literal = JSON.stringify(id ?? '').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '// grhm-node ' + literal;
}

export function routeSpecificity(route: string): number {
  return route.split('/').filter(Boolean).filter((segment) => !/^\{[^}]+\}$/.test(segment)).length;
}
