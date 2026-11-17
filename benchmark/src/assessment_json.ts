import { createHash } from 'node:crypto';

const numberTokens = new WeakMap<object, Map<string, string>>();
type ParsedAssessmentJson = { value: unknown; canonical: string; numberToken?: string };

function compareJsonKeys(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

function parseJsonDocument(text: string, maxDepth: number, excludedRootKeys: readonly string[] = [], allowLargeIntegers = false): ParsedAssessmentJson {
  if (typeof text !== 'string') throw new SyntaxError('Assessment JSON: input must be text');
  let position = 0;
  const whitespace = () => { while (position < text.length && /[\x20\t\r\n]/.test(text[position]!)) position++; };
  const fail = (): never => { throw new SyntaxError('Assessment JSON: invalid JSON syntax'); };
  const stringToken = (): string => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, position)) as string; } catch { return fail(); }
      }
      if (character === '\\') position++;
    }
    return fail();
  };
  function parseValue(depth: number): ParsedAssessmentJson {
    if (depth > maxDepth) throw new SyntaxError('Assessment JSON: nesting limit exceeded');
    whitespace();
    const character = text[position];
    if (character === '"') {
      const value = stringToken();
      return { value, canonical: JSON.stringify(value) };
    }
    if (character === '[' || character === '{') {
      const array = character === '[';
      const value: unknown[] | Record<string, unknown> = array ? [] : {};
      const entries: [string, string][] = [];
      const keys = new Set<string>();
      const tokens = new Map<string, string>();
      const end = array ? ']' : '}';
      position++;
      whitespace();
      if (text[position] !== end) {
        for (;;) {
          let key: string;
          if (array) key = String(entries.length);
          else {
            if (text[position] !== '"') return fail();
            key = stringToken();
            if (keys.has(key)) throw new SyntaxError('Assessment JSON: duplicate object key');
            keys.add(key);
            whitespace();
            if (text[position++] !== ':') return fail();
          }
          const child = parseValue(depth + 1);
          if (array) (value as unknown[]).push(child.value);
          else Object.defineProperty(value, key, { value: child.value, writable: true, enumerable: true, configurable: true });
          if (child.numberToken !== undefined) tokens.set(key, child.numberToken);
          entries.push([key, child.canonical]);
          whitespace();
          if (text[position] === end) break;
          if (text[position++] !== ',') return fail();
          whitespace();
        }
      }
      position++;
      numberTokens.set(value, tokens);
      const canonical = array
        ? '[' + entries.map(([, child]) => child).join(',') + ']'
        : '{' + entries.filter(([key]) => depth !== 0 || !excludedRootKeys.includes(key))
          .sort(([a], [b]) => compareJsonKeys(a, b))
          .map(([key, child]) => JSON.stringify(key) + ':' + child).join(',') + '}';
      return { value, canonical };
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return { value, canonical: literal };
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (!match) return fail();
    position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      if (allowLargeIntegers && !/[.eE]/.test(match[0])) {
        return { value: BigInt(match[0]), canonical: match[0], numberToken: match[0] };
      }
      throw new SyntaxError('Assessment JSON: nonfinite number');
    }
    return { value, canonical: match[0], numberToken: match[0] };
  }
  const result = parseValue(0);
  whitespace();
  if (position !== text.length) return fail();
  return result;
}

/** Parse strict JSON, rejecting duplicate keys, nonfinite numbers and excessive nesting. */
export function parseAssessmentJson(text: string, maxDepth = 100): unknown {
  return parseJsonDocument(text, maxDepth).value;
}

/** Parse model answer JSON with exact bigint values for overflow integers, never for HTTP or persistence. */
export function parseAssessmentAnswerJson(text: string, maxDepth = 64): unknown {
  return parseJsonDocument(text, maxDepth, [], true).value;
}

/** Return a parsed number's original token when integer versus float spelling matters to a grader. */
export function assessmentJsonNumberToken(container: object, key: string | number): string | undefined {
  return numberTokens.get(container)?.get(String(key));
}

/** Canonicalize original JSON without changing number spellings in historical Python evidence. */
export function canonicalAssessmentJsonText(text: string, excludedRootKeys: readonly string[] = []): string {
  return parseJsonDocument(text, 100, excludedRootKeys).canonical;
}

function serializeAssessmentValue(value: unknown, allowLargeIntegers: boolean): string {
  const ancestors = new Set<object>();
  function serialize(node: unknown, depth: number): string {
    if (depth > 100) throw new Error('Assessment JSON: nesting limit exceeded');
    if (node === null) return 'null';
    if (typeof node === 'boolean' || typeof node === 'string') return JSON.stringify(node);
    if (allowLargeIntegers && typeof node === 'bigint') return String(node);
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error('Assessment JSON: nonfinite number');
      return JSON.stringify(node);
    }
    if (typeof node !== 'object') throw new Error('Assessment JSON: unsupported value');
    if (ancestors.has(node)) throw new Error('Assessment JSON: cyclic value');
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        return '[' + Array.from(node, child => serialize(child, depth + 1)).join(',') + ']';
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(node))) {
        throw new Error('Assessment JSON: object must be a plain record');
      }
      return '{' + Object.keys(node).sort(compareJsonKeys)
        .map(key => JSON.stringify(key) + ':' + serialize((node as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
    } finally { ancestors.delete(node); }
  }
  return serialize(value, 0);
}

/** Serialize finite JSON with Unicode code-point key order; no implicit omissions or coercions. */
export function canonicalAssessmentJson(value: unknown): string {
  return serializeAssessmentValue(value, false);
}

/** Serialize answer-only bigint numeric literals for fixed graders; never use for API or evidence writes. */
export function stringifyAssessmentAnswerJson(value: unknown): string {
  return serializeAssessmentValue(value, true);
}

/** Hash canonical finite JSON; historical number lexemes require canonicalAssessmentJsonText instead. */
export function assessment_hash(value: unknown): string {
  return createHash('sha256').update(canonicalAssessmentJson(value)).digest('hex');
}
