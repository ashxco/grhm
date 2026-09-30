import { Span } from './ast.js';
import { Diagnostic, makeDiag } from './diagnostics.js';
import { MAX_SOURCE_BYTES, MAX_TOKENS } from './limits.js';

export type TokenKind = 'lparen' | 'rparen' | 'string' | 'number' | 'ident' | 'keyword' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Raw text for idents/keywords; decoded value for strings; numeric text for numbers. */
  text: string;
  span: Span;
}

const IDENT_CHARS = /[A-Za-z0-9_\-./+*=<>!?$%&|~^@]/;

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function lex(source: string, file?: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    const span = { start: 0, end: 0, line: 1, col: 1, file };
    return { tokens: [{ kind: 'eof', text: '', span }], diagnostics: [makeDiag('E004', 'error', 'Source exceeds compiler byte budget', {
      span, expected: `at most ${MAX_SOURCE_BYTES} UTF-8 bytes per file`,
    })] };
  }
  let pos = 0;
  let line = 1;
  let col = 1;

  const spanFrom = (start: number, startLine: number, startCol: number): Span => ({
    start,
    end: pos,
    line: startLine,
    col: startCol,
    ...(file !== undefined ? { file } : {}),
  });

  const advance = (): string => {
    const ch = source[pos] ?? '';
    pos += 1;
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    return ch;
  };

  while (pos < source.length) {
    if (tokens.length >= MAX_TOKENS || diagnostics.length >= 1000) {
      diagnostics.push(makeDiag('E004', 'error', 'Source exceeds compiler token/diagnostic budget', {
        span: { start: pos, end: pos, line, col, file }, expected: `at most ${MAX_TOKENS} tokens and fewer than 1000 lexical errors`,
      }));
      break;
    }
    const ch = source[pos];
    if (ch === undefined) break;

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      advance();
      continue;
    }

    if (ch === ';') {
      while (pos < source.length && source[pos] !== '\n') advance();
      continue;
    }

    const start = pos;
    const startLine = line;
    const startCol = col;

    if (ch === '(') {
      advance();
      tokens.push({ kind: 'lparen', text: '(', span: spanFrom(start, startLine, startCol) });
      continue;
    }
    if (ch === ')') {
      advance();
      tokens.push({ kind: 'rparen', text: ')', span: spanFrom(start, startLine, startCol) });
      continue;
    }

    if (ch === '"') {
      advance();
      let value = '';
      let closed = false;
      while (pos < source.length) {
        const c = advance();
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = advance();
          switch (esc) {
            case 'n':
              value += '\n';
              break;
            case 't':
              value += '\t';
              break;
            case 'r':
              value += '\r';
              break;
            case '"':
              value += '"';
              break;
            case '\\':
              value += '\\';
              break;
            default:
              diagnostics.push(
                makeDiag('E001', 'error', `Unknown string escape "\\${esc}"`, {
                  span: spanFrom(start, startLine, startCol),
                }),
              );
              value += esc;
          }
        } else {
          value += c;
        }
      }
      if (!closed) {
        diagnostics.push(
          makeDiag('E001', 'error', 'Unterminated string literal', {
            span: spanFrom(start, startLine, startCol),
          }),
        );
      }
      tokens.push({ kind: 'string', text: value, span: spanFrom(start, startLine, startCol) });
      continue;
    }

    if (ch === ':') {
      advance();
      let name = '';
      while (pos < source.length && IDENT_CHARS.test(source[pos] ?? '')) name += advance();
      if (name === '') {
        diagnostics.push(
          makeDiag('E001', 'error', 'Expected a name after ":"', {
            span: spanFrom(start, startLine, startCol),
          }),
        );
      }
      tokens.push({ kind: 'keyword', text: name, span: spanFrom(start, startLine, startCol) });
      continue;
    }

    const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
    if (isDigit(ch) || ((ch === '-' || ch === '+') && isDigit(source[pos + 1]))) {
      let text = advance();
      while (isDigit(source[pos])) text += advance();
      if (source[pos] === '.' && isDigit(source[pos + 1])) {
        text += advance();
        while (isDigit(source[pos])) text += advance();
      }
      // A number immediately followed by ident chars (e.g. `16px`) lexes as an ident.
      if (pos < source.length && IDENT_CHARS.test(source[pos] ?? '')) {
        while (pos < source.length && IDENT_CHARS.test(source[pos] ?? '')) text += advance();
        tokens.push({ kind: 'ident', text, span: spanFrom(start, startLine, startCol) });
      } else {
        if (!Number.isFinite(Number(text))) diagnostics.push(makeDiag('E001', 'error', 'Numeric literal must be finite', {
          span: spanFrom(start, startLine, startCol), received: text, expected: 'a finite number',
        }));
        tokens.push({ kind: 'number', text, span: spanFrom(start, startLine, startCol) });
      }
      continue;
    }

    if (IDENT_CHARS.test(ch)) {
      let text = '';
      while (pos < source.length && IDENT_CHARS.test(source[pos] ?? '')) text += advance();
      tokens.push({ kind: 'ident', text, span: spanFrom(start, startLine, startCol) });
      continue;
    }

    diagnostics.push(
      makeDiag('E001', 'error', `Unexpected character "${ch}"`, {
        span: { start, end: start + 1, line: startLine, col: startCol, ...(file !== undefined ? { file } : {}) },
      }),
    );
    advance();
  }

  tokens.push({ kind: 'eof', text: '', span: { start: pos, end: pos, line, col, ...(file !== undefined ? { file } : {}) } });
  return { tokens, diagnostics };
}
