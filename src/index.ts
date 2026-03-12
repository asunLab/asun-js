/**
 * ASON (Array-Schema Object Notation) — JavaScript/TypeScript library.
 *
 * Zero dependencies. Works in browsers, Node.js, Deno, Bun.
 * Compatible with Vue, React, Svelte, SolidJS, and any JS framework.
 *
 * API:
 *   encode(obj)                    → string   (untyped schema, inferred)
 *   encodeTyped(obj)               → string   (typed schema, inferred)
 *   encodePretty(obj)              → string   (pretty + untyped schema)
 *   encodePrettyTyped(obj)         → string   (pretty + typed schema)
 *   decode(text)                   → object | object[]
 *   encodeBinary(obj)              → Uint8Array (schema inferred internally)
 *   decodeBinary(data, schema)     → object | object[]
 *
 * Type inference rules (matches ason-go / ason-rs / ason-java behaviour):
 *   JS number (integer)  → int
 *   JS number (fraction) → float
 *   JS boolean           → bool
 *   JS string            → str
 *   null / undefined     → str? (optional str)
 *   Arrays are encoded as schema-once slices.
 *
 * decodeBinary still requires an explicit schema string because the binary
 * format carries no embedded type information. All other APIs are schema-free.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AsonObj = Record<string, unknown>;
export type AsonResult = AsonObj | AsonObj[];

type BaseType = 'int' | 'uint' | 'float' | 'bool' | 'str' | 'map' | 'list' | 'struct';
type FieldType = BaseType | `${BaseType}?` | string;

interface Field {
  name: string;
  base: BaseType;
  optional: boolean;
  typeExpr: string;
}

interface ParsedSchema {
  fields: Field[];
  isSlice: boolean;
}

// ---------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------

const NEEDS_QUOTE = new Uint8Array(256);
for (let i = 0; i < 32; i++) NEEDS_QUOTE[i] = 1;
for (const ch of [',', '(', ')', '[', ']', '"', '\\']) {
  NEEDS_QUOTE[ch.charCodeAt(0)] = 1;
}

// ---------------------------------------------------------------------------
// Type inference: derive field list from an object
// ---------------------------------------------------------------------------

function inferBaseType(val: unknown): BaseType {
  if (typeof val === 'boolean') return 'bool';
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'int' : 'float';
  }
  if (typeof val === 'bigint') return 'int';
  if (Array.isArray(val)) return 'list';
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) return 'map';
  return 'str';
}

function baseTypeFromExpr(typeExpr: string): BaseType {
  if (typeExpr.startsWith('<')) return 'map';
  if (typeExpr.startsWith('[')) return 'list';
  if (typeExpr.startsWith('{')) return 'struct';
  return typeExpr as BaseType;
}

function unifyTypeExpr(a: string, b: string): string {
  if (a === b) return a;
  if ((a === 'int' && b === 'float') || (a === 'float' && b === 'int')) return 'float';
  return 'str';
}

function inferStructTypeExpr(sample: AsonObj): string {
  const fields = Object.keys(sample).map(name => {
    const val = sample[name];
    const optional = val === null || val === undefined;
    const typeExpr = optional ? 'str' : inferValueTypeExpr(val);
    return `${name}:${optional ? `${typeExpr}?` : typeExpr}`;
  });
  return `{${fields.join(',')}}`;
}

function inferValueTypeExpr(val: unknown): string {
  if (val === null || val === undefined) return 'str';
  if (typeof val === 'boolean') return 'bool';
  if (typeof val === 'number') return Number.isInteger(val) ? 'int' : 'float';
  if (typeof val === 'bigint') return 'int';
  if (typeof val === 'string') return 'str';
  if (Array.isArray(val)) {
    let elemExpr = 'str';
    let hasNonNull = false;
    let optional = false;
    for (const item of val) {
      if (item === null || item === undefined) {
        optional = true;
        continue;
      }
      const cur = typeof item === 'object' && item !== null && !Array.isArray(item)
        ? inferStructTypeExpr(item as AsonObj)
        : inferValueTypeExpr(item);
      elemExpr = hasNonNull ? unifyTypeExpr(elemExpr, cur) : cur;
      hasNonNull = true;
    }
    if (!hasNonNull) elemExpr = 'str';
    if (optional && !elemExpr.endsWith('?')) elemExpr += '?';
    return `[${elemExpr}]`;
  }
  if (typeof val === 'object') {
    const values = Object.values(val as Record<string, unknown>);
    let valueExpr = 'str';
    let hasNonNull = false;
    let optional = false;
    for (const item of values) {
      if (item === null || item === undefined) {
        optional = true;
        continue;
      }
      const cur = inferValueTypeExpr(item);
      valueExpr = hasNonNull ? unifyTypeExpr(valueExpr, cur) : cur;
      hasNonNull = true;
    }
    if (!hasNonNull) valueExpr = 'str';
    if (optional && !valueExpr.endsWith('?')) valueExpr += '?';
    return `<str:${valueExpr}>`;
  }
  return 'str';
}

/** Infer a Field array from a sample object (or the first element of an array). */
function inferFields(sample: AsonObj): Field[] {
  return Object.keys(sample).map(name => {
    const val = sample[name];
    const optional = val === null || val === undefined;
    const typeExpr = optional ? 'str' : inferValueTypeExpr(val);
    const base: BaseType = baseTypeFromExpr(typeExpr);
    return { name, base, optional, typeExpr };
  });
}

/** Build an untyped schema header string, e.g. "{id,name,active}" or "[{...}]" */
function buildUntypedHeader(fields: Field[], isSlice: boolean): string {
  const inner = '{' + fields.map(f => f.name).join(',') + '}';
  return isSlice ? '[' + inner + ']' : inner;
}

/** Build a typed schema header string, e.g. "{id:int,name:str,active:bool}" */
function buildTypedHeader(fields: Field[], isSlice: boolean): string {
  const inner = '{' + fields.map(f => {
    const t: string = f.optional ? f.typeExpr + '?' : f.typeExpr;
    return f.name + ':' + t;
  }).join(',') + '}';
  return isSlice ? '[' + inner + ']' : inner;
}

// ---------------------------------------------------------------------------
// Schema parsing (for decodeBinary and decode())
// ---------------------------------------------------------------------------

const _schemaCache = new Map<string, ParsedSchema>();

function parseSchema(schema: string): ParsedSchema {
  const cached = _schemaCache.get(schema);
  if (cached) return cached;
  const result = parseSchemaInner(schema);
  _schemaCache.set(schema, result);
  return result;
}

function parseSchemaInner(schema: string): ParsedSchema {
  let pos = 0;
  const n = schema.length;

  const skip = () => { while (pos < n && (schema[pos] === ' ' || schema[pos] === '\t')) pos++; };

  skip();
  let isSlice = false;
  if (pos < n && schema[pos] === '[') { isSlice = true; pos++; }

  skip();
  if (pos >= n || schema[pos] !== '{') throw new AsonError(`expected '{' in schema`);
  pos++; // consume '{'

  const fields: Field[] = [];
  while (pos < n) {
    skip();
    if (pos >= n) throw new AsonError('unexpected end in schema');
    if (schema[pos] === '}') { pos++; break; }
    if (fields.length > 0) {
      if (schema[pos] !== ',') throw new AsonError(`expected ',' in schema`);
      pos++;
      skip();
    }

    const ns = pos;
    while (pos < n && schema[pos] !== ':' && schema[pos] !== ',' && schema[pos] !== '}' && schema[pos] !== ' ' && schema[pos] !== '\t') pos++;
    const name = schema.slice(ns, pos);
    if (!name) throw new AsonError('empty field name in schema');

    skip();

    let typePart: string = 'str';
    if (pos < n && schema[pos] === ':') {
      pos++; // consume ':'
      skip();
      if (pos < n && (schema[pos] === '{' || schema[pos] === '[' || schema[pos] === '<')) {
        const scanned = scanTypeExpr(schema, pos);
        typePart = scanned.typeExpr;
        pos = scanned.end;
      } else {
        const ts = pos;
        while (pos < n && schema[pos] !== ',' && schema[pos] !== '}' && schema[pos] !== ' ' && schema[pos] !== '\t') pos++;
        typePart = schema.slice(ts, pos);
      }
    }

    const optional = typePart.endsWith('?');
    const basePart = optional ? typePart.slice(0, -1) : typePart;
    const base = (basePart.startsWith('<') ? 'map' : basePart) as BaseType;
    if (!['int', 'uint', 'float', 'bool', 'str', 'map'].includes(base)) {
      throw new AsonError(`unknown type '${base}' in schema`);
    }
    fields.push({ name, base, optional, typeExpr: basePart });
  }

  if (isSlice) {
    skip();
    if (pos >= n || schema[pos] !== ']') throw new AsonError(`expected ']' after schema`);
    pos++;
  }

  return { fields, isSlice };
}

// ---------------------------------------------------------------------------
// String quoting helpers
// ---------------------------------------------------------------------------

function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (s.length <= 5 && (s === 'true' || s === 'false')) return true;
  if (s[0] === ' ' || s[s.length - 1] === ' ') return true;
  let couldBeNum = true;
  const numStart = s[0] === '-' ? 1 : 0;
  if (numStart >= s.length) couldBeNum = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (NEEDS_QUOTE[c]) return true;
    if (couldBeNum && i >= numStart && !((c >= 48 && c <= 57) || c === 46)) couldBeNum = false;
  }
  return couldBeNum && s.length > numStart;
}

function quoteStr(s: string): string {
  const parts: string[] = ['"'];
  let i = 0;
  while (i < s.length) {
    const run = i;
    while (i < s.length && s[i] !== '"' && s[i] !== '\\' && s[i] !== '\n' && s[i] !== '\t') i++;
    if (i > run) parts.push(s.slice(run, i));
    if (i >= s.length) break;
    const c = s[i++];
    if (c === '"') parts.push('\\"');
    else if (c === '\\') parts.push('\\\\');
    else if (c === '\n') parts.push('\\n');
    else if (c === '\t') parts.push('\\t');
  }
  parts.push('"');
  return parts.join('');
}

function encodeStr(s: string): string {
  return needsQuoting(s) ? quoteStr(s) : s;
}

function formatFloat(v: number): string {
  if (!isFinite(v)) return '0';
  if (Object.is(v, -0)) return '0';
  if (Number.isInteger(v)) return v.toFixed(1);
  let s = v.toPrecision(15).replace(/\.?0+$/, '');
  if (!s.includes('.')) s += '.0';
  return s;
}

function splitMapTypeExpr(typeExpr: string): { keyExpr: string; valueExpr: string } {
  if (!typeExpr.startsWith('<') || !typeExpr.endsWith('>')) return { keyExpr: 'str', valueExpr: 'str' };
  let depthAngle = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  for (let i = 1; i < typeExpr.length - 1; i++) {
    const c = typeExpr[i]!;
    if (c === '<') depthAngle++;
    else if (c === '>') depthAngle--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '[') depthBracket++;
    else if (c === ']') depthBracket--;
    else if (c === ':' && depthAngle === 0 && depthBrace === 0 && depthBracket === 0) {
      return {
        keyExpr: typeExpr.slice(1, i).trim() || 'str',
        valueExpr: typeExpr.slice(i + 1, -1).trim() || 'str'
      };
    }
  }
  return { keyExpr: 'str', valueExpr: 'str' };
}

function stripOptional(typeExpr: string): { inner: string; optional: boolean } {
  return typeExpr.endsWith('?')
    ? { inner: typeExpr.slice(0, -1), optional: true }
    : { inner: typeExpr, optional: false };
}

function scanBalanced(src: string, pos: number, open: string, close: string): number {
  let depth = 0;
  while (pos < src.length) {
    const c = src[pos]!;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return pos + 1;
    }
    pos++;
  }
  return pos;
}

function scanTypeExpr(src: string, pos: number): { typeExpr: string; end: number } {
  if (pos >= src.length) return { typeExpr: 'str', end: pos };
  const c = src[pos]!;
  if (c === '{') {
    const end = scanBalanced(src, pos, '{', '}');
    return { typeExpr: src.slice(pos, end), end };
  }
  if (c === '[') {
    const end = scanBalanced(src, pos, '[', ']');
    return { typeExpr: src.slice(pos, end), end };
  }
  if (c === '<') {
    const end = scanBalanced(src, pos, '<', '>');
    return { typeExpr: src.slice(pos, end), end };
  }
  const start = pos;
  while (pos < src.length && src[pos] !== ',' && src[pos] !== '}' && src[pos] !== ' ' && src[pos] !== '\t') pos++;
  return { typeExpr: src.slice(start, pos), end: pos };
}

function parseScalarToken(token: string): string | number | boolean | undefined {
  if (token === 'true') return true;
  if (token === 'false') return false;
  let i = 0;
  if (token[0] === '-') i = 1;
  let seenDigit = false;
  let seenDot = false;
  for (; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      seenDigit = true;
      continue;
    }
    if (c === 46 && !seenDot) {
      seenDot = true;
      continue;
    }
    return undefined;
  }
  if (!seenDigit) return undefined;
  return seenDot ? Number.parseFloat(token) : Number.parseInt(token, 10);
}

function encodeGenericValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isInteger(val) ? String(val) : formatFloat(val);
  if (typeof val === 'bigint') return String(val);
  if (typeof val === 'string') return encodeStr(val);
  if (Array.isArray(val)) {
    return '[' + val.map(item => encodeGenericValue(item)).join(', ') + ']';
  }
  if (typeof val === 'object') {
    return encodeByTypeExpr(val, inferValueTypeExpr(val), false);
  }
  return encodeStr(String(val));
}

function encodeByTypeExpr(val: unknown, typeExpr: string, optional: boolean): string {
  if (optional && (val === null || val === undefined)) return '';
  const { inner } = stripOptional(typeExpr);
  switch (baseTypeFromExpr(inner)) {
    case 'bool':
      return val ? 'true' : 'false';
    case 'int':
    case 'uint':
      return String(typeof val === 'bigint' ? val : Math.trunc(Number(val)));
    case 'float':
      return formatFloat(Number(val));
    case 'str':
      return encodeStr(String(val));
    case 'list': {
      const itemExpr = inner.slice(1, -1).trim() || 'str';
      const items = Array.isArray(val) ? val : [];
      return '[' + items.map(item => encodeByTypeExpr(item, itemExpr, stripOptional(itemExpr).optional)).join(', ') + ']';
    }
    case 'struct': {
      const fields = parseSchema(inner).fields;
      return encodeTuple(val as AsonObj, fields);
    }
    case 'map': {
      const { valueExpr } = splitMapTypeExpr(inner);
      const obj = (val as Record<string, unknown>) ?? {};
      const parts: string[] = ['<'];
      let first = true;
      for (const k in obj) {
        if (!first) parts.push(', ');
        first = false;
        parts.push(encodeStr(k), ': ');
        const entry = obj[k];
        if (entry === null || entry === undefined) {
          parts.push('');
          continue;
        }
        if (valueExpr === 'str' && (typeof entry !== 'string')) parts.push(encodeGenericValue(entry));
        else parts.push(encodeByTypeExpr(entry, valueExpr, stripOptional(valueExpr).optional));
      }
      parts.push('>');
      return parts.join('');
    }
  }
}

// ---------------------------------------------------------------------------
// Encode a single value given its inferred type
// ---------------------------------------------------------------------------

function encodeValue(val: unknown, base: BaseType, optional: boolean): string {
  return encodeByTypeExpr(val, base, optional);
}

// ---------------------------------------------------------------------------
// Encode tuple (one row) using inferred fields
// ---------------------------------------------------------------------------

function encodeTuple(obj: AsonObj, fields: Field[]): string {
  let s = '(';
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) s += ',';
    const f = fields[i]!;
    s += encodeByTypeExpr(obj[f.name], f.typeExpr, f.optional);
  }
  return s + ')';
}

// ---------------------------------------------------------------------------
// encode(obj) → string   [untyped schema, inferred]
// ---------------------------------------------------------------------------

export function encode(obj: AsonResult): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[{}]:\n';
    const fields = inferFields(obj[0]!);
    const hdr = buildUntypedHeader(fields, true);
    let out = hdr + ':\n';
    for (let i = 0; i < obj.length; i++) {
      out += encodeTuple(obj[i]!, fields);
      if (i < obj.length - 1) out += ',\n';
    }
    out += '\n';
    return out;
  } else {
    const fields = inferFields(obj as AsonObj);
    const hdr = buildUntypedHeader(fields, false);
    return hdr + ':\n' + encodeTuple(obj as AsonObj, fields) + '\n';
  }
}

// ---------------------------------------------------------------------------
// encodeTyped(obj) → string  [typed schema, inferred]
// ---------------------------------------------------------------------------

export function encodeTyped(obj: AsonResult): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[{}]:\n';
    const fields = inferFields(obj[0]!);
    const hdr = buildTypedHeader(fields, true);
    let out = hdr + ':\n';
    for (let i = 0; i < obj.length; i++) {
      out += encodeTuple(obj[i]!, fields);
      if (i < obj.length - 1) out += ',\n';
    }
    out += '\n';
    return out;
  } else {
    const fields = inferFields(obj as AsonObj);
    const hdr = buildTypedHeader(fields, false);
    return hdr + ':\n' + encodeTuple(obj as AsonObj, fields) + '\n';
  }
}

// ---------------------------------------------------------------------------
// encodePretty(obj) → string  [pretty + untyped schema]
// ---------------------------------------------------------------------------

export function encodePretty(obj: AsonResult): string {
  return prettyFormat(encode(obj));
}

// ---------------------------------------------------------------------------
// encodePrettyTyped(obj) → string  [pretty + typed schema]
// ---------------------------------------------------------------------------

export function encodePrettyTyped(obj: AsonResult): string {
  return prettyFormat(encodeTyped(obj));
}

// ---------------------------------------------------------------------------
// Pretty formatter
// ---------------------------------------------------------------------------

const PRETTY_MAX_WIDTH = 100;

function prettyFormat(src: string): string {
  const match = buildMatchTable(src);
  const f = new PrettyFmt(src, match);
  f.writeTop();
  return f.out;
}

function buildMatchTable(src: string): Int32Array {
  const n = src.length;
  const match = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let inQuote = false;
  for (let i = 0; i < n; i++) {
    if (inQuote) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '"') inQuote = false;
      continue;
    }
    if (src[i] === '"') { inQuote = true; continue; }
    if (src[i] === '(' || src[i] === '[' || src[i] === '{' || src[i] === '<') {
      stack.push(i);
    } else if (src[i] === ')' || src[i] === ']' || src[i] === '}' || src[i] === '>') {
      if (stack.length > 0) {
        const open = stack.pop()!;
        match[open] = i;
        match[i] = open;
      }
    }
  }
  return match;
}

class PrettyFmt {
  src: string; match: Int32Array; out = ''; pos = 0; depth = 0;
  constructor(src: string, match: Int32Array) { this.src = src; this.match = match; }

  indent(): string { return '  '.repeat(this.depth); }

  isSimple(start: number, end: number): boolean {
    return end - start <= PRETTY_MAX_WIDTH && !this.src.slice(start, end + 1).includes('\n');
  }

  writeTop(): void {
    const src = this.src;
    const n = src.length;
    let depth = 0;
    let sepIdx = -1;
    let inQ = false;
    for (let i = 0; i < n; i++) {
      const c = src[i];
      if (inQ) { if (c === '\\') { i++; continue; } if (c === '"') inQ = false; continue; }
      if (c === '"') { inQ = true; continue; }
      if (c === '{' || c === '[' || c === '<') depth++;
      else if (c === '}' || c === ']' || c === '>') depth--;
      else if (c === ':' && depth === 0) { sepIdx = i; break; }
    }
    if (sepIdx === -1) { this.out = src; return; }
    this.out += src.slice(0, sepIdx + 1);
    this.pos = sepIdx + 1;
    this.skipNewlines();
    this.out += '\n';
    while (this.pos < n) {
      this.skipWhitespaceAndCommas();
      if (this.pos >= n) break;
      if (src[this.pos] === '(') {
        const close = this.match[this.pos];
        if (close === -1 || this.isSimple(this.pos, close)) {
          while (this.pos <= close) this.out += src[this.pos++];
        } else {
          this.writeTuple();
        }
        this.skipWhitespace();
        if (this.pos < n && src[this.pos] === ',') { this.out += ',\n'; this.pos++; }
        else this.out += '\n';
      } else {
        this.out += src[this.pos++];
      }
    }
  }

  writeTuple(): void {
    this.out += '(\n';
    this.pos++;
    this.depth++;
    let first = true;
    while (this.pos < this.src.length && this.src[this.pos] !== ')') {
      this.skipWhitespace();
      if (this.src[this.pos] === ',') { this.pos++; this.skipWhitespace(); continue; }
      if (!first) this.out += ',\n';
      first = false;
      this.out += this.indent();
      this.writeValue();
    }
    this.depth--;
    this.out += '\n' + this.indent() + ')';
    if (this.pos < this.src.length) this.pos++;
  }

  writeValue(): void {
    const src = this.src;
    if (this.pos >= src.length) return;
    const c = src[this.pos];
    if (c === '(' || c === '[' || c === '<') {
      const close = this.match[this.pos];
      if (close === -1 || this.isSimple(this.pos, close)) {
        while (this.pos <= close) this.out += src[this.pos++];
      } else {
        if (c === '(') this.writeTuple();
        else if (c === '[') this.writeList();
        else this.writeMap();
      }
    } else if (c === '"') {
      this.out += src[this.pos++];
      while (this.pos < src.length) {
        const ch = src[this.pos];
        this.out += ch;
        this.pos++;
        if (ch === '\\') { this.out += src[this.pos++]; continue; }
        if (ch === '"') break;
      }
    } else {
      while (this.pos < src.length && src[this.pos] !== ',' && src[this.pos] !== ')' && src[this.pos] !== ']' && src[this.pos] !== '>') {
        this.out += src[this.pos++];
      }
    }
  }

  writeList(): void {
    this.out += '[\n';
    this.pos++;
    this.depth++;
    let first = true;
    while (this.pos < this.src.length && this.src[this.pos] !== ']') {
      this.skipWhitespace();
      if (this.src[this.pos] === ',') { this.pos++; this.skipWhitespace(); continue; }
      if (!first) this.out += ',\n';
      first = false;
      this.out += this.indent();
      this.writeValue();
    }
    this.depth--;
    this.out += '\n' + this.indent() + ']';
    if (this.pos < this.src.length) this.pos++;
  }

  writeMap(): void {
    this.out += '<\n';
    this.pos++;
    this.depth++;
    let first = true;
    while (this.pos < this.src.length && this.src[this.pos] !== '>') {
      this.skipWhitespace();
      if (this.src[this.pos] === ',') { this.pos++; this.skipWhitespace(); continue; }
      if (!first) this.out += ',\n';
      first = false;
      this.out += this.indent();
      while (this.pos < this.src.length && this.src[this.pos] !== ':') {
        this.out += this.src[this.pos++];
      }
      if (this.pos < this.src.length && this.src[this.pos] === ':') {
        this.out += ': ';
        this.pos++;
        this.skipWhitespace();
      }
      this.writeValue();
    }
    this.depth--;
    this.out += '\n' + this.indent() + '>';
    if (this.pos < this.src.length) this.pos++;
  }

  skipWhitespace(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t' || this.src[this.pos] === '\n' || this.src[this.pos] === '\r')) this.pos++;
  }
  skipNewlines(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === '\n' || this.src[this.pos] === '\r')) this.pos++;
  }
  skipWhitespaceAndCommas(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos++;
      else break;
    }
  }
}

// ---------------------------------------------------------------------------
// decode(text) → AsonResult  [schema is embedded in the text]
// ---------------------------------------------------------------------------

export function decode(text: string): AsonResult {
  const dec = new Decoder(text);
  return dec.decodeTop();
}

class Decoder {
  src: string; pos: number;
  constructor(src: string) { this.src = src; this.pos = 0; }

  err(msg: string): never { throw new AsonError(`${msg} at pos ${this.pos}`); }

  skip(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.pos++; continue; }
      if (c === '/' && this.pos + 1 < s.length && s[this.pos + 1] === '*') {
        this.pos += 2;
        while (this.pos + 1 < s.length && !(s[this.pos] === '*' && s[this.pos + 1] === '/')) this.pos++;
        this.pos += 2;
        continue;
      }
      break;
    }
  }

  decodeTop(): AsonResult {
    this.skip();
    const s = this.src;
    const isSlice = s[this.pos] === '[' && this.pos + 1 < s.length && s[this.pos + 1] === '{';

    if (isSlice) {
      this.pos++; // skip '['
    }

    if (this.pos >= s.length || s[this.pos] !== '{') this.err('expected {');
    const fields = this.parseSchemaFields();

    this.skip();
    if (isSlice) {
      if (this.pos >= s.length || s[this.pos] !== ']') this.err('expected ]');
      this.pos++;
    }
    this.skip();
    if (this.pos >= s.length || s[this.pos] !== ':') this.err('expected :');
    this.pos++;

    if (isSlice) {
      const results: AsonObj[] = [];
      while (true) {
        this.skip();
        if (this.pos >= s.length || s[this.pos] !== '(') break;
        results.push(this.parseTuple(fields));
        this.skip();
        if (this.pos < s.length && s[this.pos] === ',') { this.pos++; }
      }
      return results;
    } else {
      this.skip();
      const obj = this.parseTuple(fields);
      this.skip();
      if (this.pos < s.length) this.err('trailing content after decoded value');
      return obj;
    }
  }

  parseSchemaFields(): Field[] {
    const s = this.src;
    if (s[this.pos] !== '{') this.err('expected {');
    this.pos++;
    const fields: Field[] = [];
    while (this.pos < s.length) {
      this.skip();
      if (s[this.pos] === '}') { this.pos++; break; }
      if (fields.length > 0) {
        if (s[this.pos] !== ',') this.err('expected , in schema');
        this.pos++;
        this.skip();
      }
      const ns = this.pos;
      while (this.pos < s.length && s[this.pos] !== ':' && s[this.pos] !== ',' && s[this.pos] !== '}' && s[this.pos] !== ' ' && s[this.pos] !== '\t') this.pos++;
      const name = s.slice(ns, this.pos);
      if (!name) this.err('empty field name');
      this.skip();
      let typePart: string = 'str';
      if (this.pos < s.length && s[this.pos] === ':') {
        this.pos++;
        this.skip();
        if (this.pos < s.length && (s[this.pos] === '{' || s[this.pos] === '[' || s[this.pos] === '<')) {
          const scanned = scanTypeExpr(s, this.pos);
          typePart = scanned.typeExpr;
          this.pos = scanned.end;
        } else {
          const ts = this.pos;
          while (this.pos < s.length && s[this.pos] !== ',' && s[this.pos] !== '}' && s[this.pos] !== ' ' && s[this.pos] !== '\t') this.pos++;
          typePart = s.slice(ts, this.pos);
        }
      }
      const optional = typePart.endsWith('?');
      const basePart = optional ? typePart.slice(0, -1) : typePart;
      const base = (basePart.startsWith('<') ? 'map' : basePart) as BaseType;
      fields.push({ name, base, optional, typeExpr: basePart });
    }
    return fields;
  }

  parseTuple(fields: Field[]): AsonObj {
    const s = this.src;
    if (s[this.pos] !== '(') this.err('expected (');
    this.pos++;
    const obj: AsonObj = {};
    for (let i = 0; i < fields.length; i++) {
      this.skip();
      if (this.pos >= s.length || s[this.pos] === ')') {
        for (let j = i; j < fields.length; j++) {
          if (fields[j]!.optional) obj[fields[j]!.name] = null;
        }
        break;
      }
      if (i > 0) {
        if (s[this.pos] !== ',') this.err('expected ,');
        this.pos++;
        this.skip();
      }
      const f = fields[i]!;
      if (f.optional && (this.pos >= s.length || s[this.pos] === ',' || s[this.pos] === ')')) {
        obj[f.name] = null;
        continue;
      }
      obj[f.name] = this.parseTypeExpr(f.typeExpr);
    }
    this.skip();
    if (this.pos < s.length && s[this.pos] === ')') this.pos++;
    return obj;
  }

  parseTypeExpr(typeExpr: string): unknown {
    this.skip();
    const { inner, optional } = stripOptional(typeExpr);
    if (optional && (this.pos >= this.src.length || this.src[this.pos] === ',' || this.src[this.pos] === ')' || this.src[this.pos] === ']' || this.src[this.pos] === '>')) {
      return null;
    }
    switch (baseTypeFromExpr(inner)) {
      case 'bool':  return this.parseBool();
      case 'int':   return this.parseInt();
      case 'uint':  return this.parseUint();
      case 'float': return this.parseFloat();
      case 'str':   return this.parseString();
      case 'map':   return this.parseMap(inner);
      case 'list':  return this.parseList(inner.slice(1, -1).trim() || 'str');
      case 'struct': return this.parseTuple(parseSchema(inner).fields);
    }
  }

  parseGenericValue(): unknown {
    this.skip();
    const s = this.src;
    if (this.pos >= s.length || s[this.pos] === ',' || s[this.pos] === ')' || s[this.pos] === ']' || s[this.pos] === '>') return null;
    const c = s[this.pos]!;
    if (c === '"') return this.parseQuotedString();
    if (c === '<') return this.parseMap();
    if (c === '[') return this.parseList();
    if (c === '(') return this.parseGenericTuple();
    if (s.startsWith('true', this.pos)) return this.parseBool();
    if (s.startsWith('false', this.pos)) return this.parseBool();
    const token = this.parsePlainToken([',', ')', ']', '>']).trim();
    if (token === '') return null;
    const scalar = parseScalarToken(token);
    if (scalar !== undefined) return scalar;
    return token.includes('\\') ? unescapePlain(token) : token;
  }

  parsePlainToken(terminators: string[]): string {
    const s = this.src;
    const start = this.pos;
    let depthParen = 0;
    let depthBracket = 0;
    let depthAngle = 0;
    let inQuote = false;
    while (this.pos < s.length) {
      const c = s[this.pos]!;
      if (inQuote) {
        if (c === '\\') {
          this.pos += 2;
          continue;
        }
        this.pos++;
        if (c === '"') inQuote = false;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        this.pos++;
        continue;
      }
      if (c === '(') depthParen++;
      else if (c === ')') {
        if (depthParen === 0 && terminators.includes(c)) break;
        if (depthParen > 0) depthParen--;
      } else if (c === '[') depthBracket++;
      else if (c === ']') {
        if (depthBracket === 0 && terminators.includes(c)) break;
        if (depthBracket > 0) depthBracket--;
      } else if (c === '<') depthAngle++;
      else if (c === '>') {
        if (depthAngle === 0 && terminators.includes(c)) break;
        if (depthAngle > 0) depthAngle--;
      } else if (depthParen === 0 && depthBracket === 0 && depthAngle === 0 && terminators.includes(c)) {
        break;
      }
      if (c === '\\') this.pos += 2;
      else this.pos++;
    }
    return s.slice(start, this.pos);
  }

  parseGenericTuple(): unknown[] {
    const s = this.src;
    if (s[this.pos] !== '(') this.err('expected (');
    this.pos++;
    const out: unknown[] = [];
    while (this.pos < s.length) {
      this.skip();
      if (s[this.pos] === ')') { this.pos++; break; }
      out.push(this.parseGenericValue());
      this.skip();
      if (this.pos < s.length && s[this.pos] === ',') this.pos++;
    }
    return out;
  }

  parseList(itemTypeExpr?: string): unknown[] {
    const s = this.src;
    if (s[this.pos] !== '[') this.err('expected [');
    this.pos++;
    const out: unknown[] = [];
    while (this.pos < s.length) {
      this.skip();
      if (s[this.pos] === ']') { this.pos++; break; }
      out.push(itemTypeExpr ? this.parseTypeExpr(itemTypeExpr) : this.parseGenericValue());
      this.skip();
      if (this.pos < s.length && s[this.pos] === ',') this.pos++;
    }
    return out;
  }

  parseMap(typeExpr?: string): AsonObj {
    const s = this.src;
    if (s[this.pos] !== '<') {
       if (s[this.pos] === ',' || s[this.pos] === ')' || s[this.pos] === ']') return null as any; 
       this.err('expected <');
    }
    this.pos++; // skip '<'
    const obj: AsonObj = {};
    const { valueExpr } = typeExpr ? splitMapTypeExpr(typeExpr) : { valueExpr: '' };
    while (this.pos < s.length) {
      this.skip();
      if (s[this.pos] === '>') { this.pos++; break; }
      
      const start = this.pos;
      let inQuote = s[this.pos] === '"';
      let key = '';
      if (inQuote) {
          key = this.parseQuotedString();
      } else {
          while (this.pos < s.length && s[this.pos] !== ':' && s[this.pos] !== '>' && s[this.pos] !== ' ' && s[this.pos] !== '\t' && s[this.pos] !== '\n' && s[this.pos] !== '\r') {
              if (s[this.pos] === '\\') this.pos += 2;
              else this.pos++;
          }
          key = unescapePlain(s.slice(start, this.pos));
      }
      this.skip();
      if (s[this.pos] !== ':') this.err('expected : in map');
      this.pos++; // skip :
      
      this.skip();
      if (this.pos >= s.length || s[this.pos] === ',' || s[this.pos] === '>') {
          obj[key] = null;
      } else {
          obj[key] = valueExpr && valueExpr !== 'str'
            ? this.parseTypeExpr(valueExpr)
            : this.parseGenericValue();
      }
      
      this.skip();
      if (this.pos < s.length && s[this.pos] === ',') {
          this.pos++;
      }
    }
    return obj;
  }

  parseBool(): boolean {
    const s = this.src;
    if (s.startsWith('true', this.pos)) { this.pos += 4; return true; }
    if (s.startsWith('false', this.pos)) { this.pos += 5; return false; }
    this.err('invalid bool');
  }

  parseInt(): number {
    const s = this.src;
    let neg = false;
    if (s[this.pos] === '-') { neg = true; this.pos++; }
    const start = this.pos;
    let v = 0;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c < 48 || c > 57) break;
      v = v * 10 + (c - 48);
      this.pos++;
    }
    if (this.pos === start) this.err('invalid int');
    return neg ? -v : v;
  }

  parseUint(): number {
    const s = this.src;
    const start = this.pos;
    let v = 0;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c < 48 || c > 57) break;
      v = v * 10 + (c - 48);
      this.pos++;
    }
    if (this.pos === start) this.err('invalid uint');
    return v;
  }

  parseFloat(): number {
    const s = this.src;
    const start = this.pos;
    if (s[this.pos] === '-') this.pos++;
    while (this.pos < s.length && s[this.pos] >= '0' && s[this.pos] <= '9') this.pos++;
    if (this.pos < s.length && s[this.pos] === '.') {
      this.pos++;
      while (this.pos < s.length && s[this.pos] >= '0' && s[this.pos] <= '9') this.pos++;
    }
    if (this.pos === start) this.err('invalid float');
    return parseFloat(s.slice(start, this.pos));
  }

  parseString(): string {
    const s = this.src;
    if (s[this.pos] === '"') return this.parseQuotedString();
    const start = this.pos;
    while (this.pos < s.length && s[this.pos] !== ',' && s[this.pos] !== ')' && s[this.pos] !== ']') {
      if (s[this.pos] === '\\') this.pos += 2;
      else this.pos++;
    }
    const raw = s.slice(start, this.pos);
    if (raw.includes('\\')) return unescapePlain(raw);
    return raw;
  }

  parseQuotedString(): string {
    this.pos++;
    const s = this.src;
    const start = this.pos;
    let scan = this.pos;
    while (scan < s.length && s[scan] !== '"' && s[scan] !== '\\') scan++;
    if (scan < s.length && s[scan] === '"') {
      this.pos = scan + 1;
      return s.slice(start, scan);
    }
    const parts: string[] = [];
    if (scan > start) parts.push(s.slice(start, scan));
    this.pos = scan;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '"') { this.pos++; break; }
      if (c === '\\') {
        this.pos++;
        const e = s[this.pos++];
        if (e === 'n') parts.push('\n');
        else if (e === 't') parts.push('\t');
        else parts.push(e);
      } else {
        const rs = this.pos;
        while (this.pos < s.length && s[this.pos] !== '"' && s[this.pos] !== '\\') this.pos++;
        parts.push(s.slice(rs, this.pos));
      }
    }
    return parts.join('');
  }
}

function unescapePlain(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      if (s[i] === 'n') out += '\n';
      else if (s[i] === 't') out += '\t';
      else out += s[i];
    } else out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binary encode/decode
//
// encodeBinary(obj)             — schema inferred internally, not exposed
// decodeBinary(data, schema)    — schema string still required (binary has no embedded types)
//
// Wire format (LE):
//   int   → 8 bytes i64
//   uint  → 8 bytes u64
//   float → 8 bytes f64
//   bool  → 1 byte (0/1)
//   str   → 4-byte length + UTF-8 bytes
//   opt?  → 1-byte tag (0=null, 1=present) + value if present
//   slice → 4-byte count + each element
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const _f64Buf = new ArrayBuffer(8);
const _f64View = new DataView(_f64Buf);
const _f64Bytes = new Uint8Array(_f64Buf);

class BinWriter {
  buf: Uint8Array;
  len: number;
  constructor(cap: number) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }
  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let nc = this.buf.length;
    while (nc < this.len + need) nc = nc * 2;
    const nb = new Uint8Array(nc);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  push(b: number): void {
    if (this.len >= this.buf.length) this.grow(1);
    this.buf[this.len++] = b;
  }
  pushU32LE(v: number): void {
    this.grow(4);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >> 8) & 0xFF;
    this.buf[this.len++] = (v >> 16) & 0xFF;
    this.buf[this.len++] = (v >> 24) & 0xFF;
  }
  pushI64LE(v: number | bigint): void {
    this.grow(8);
    if (typeof v === 'number' && v >= -2147483648 && v <= 2147483647) {
      const iv = v | 0;
      this.buf[this.len++] = iv & 0xFF;
      this.buf[this.len++] = (iv >> 8) & 0xFF;
      this.buf[this.len++] = (iv >> 16) & 0xFF;
      this.buf[this.len++] = (iv >> 24) & 0xFF;
      const sign = iv < 0 ? 0xFF : 0;
      this.buf[this.len++] = sign;
      this.buf[this.len++] = sign;
      this.buf[this.len++] = sign;
      this.buf[this.len++] = sign;
      return;
    }
    const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
    const lo = Number(big & 0xFFFFFFFFn);
    const hi = Number((big >> 32n) & 0xFFFFFFFFn);
    this.buf[this.len++] = lo & 0xFF;
    this.buf[this.len++] = (lo >> 8) & 0xFF;
    this.buf[this.len++] = (lo >> 16) & 0xFF;
    this.buf[this.len++] = (lo >> 24) & 0xFF;
    this.buf[this.len++] = hi & 0xFF;
    this.buf[this.len++] = (hi >> 8) & 0xFF;
    this.buf[this.len++] = (hi >> 16) & 0xFF;
    this.buf[this.len++] = (hi >> 24) & 0xFF;
  }
  pushF64LE(v: number): void {
    this.grow(8);
    _f64View.setFloat64(0, v, true);
    this.buf.set(_f64Bytes, this.len);
    this.len += 8;
  }
  pushBytes(data: Uint8Array): void {
    this.grow(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function writeBinByTypeExpr(w: BinWriter, val: unknown, typeExpr: string, optional = false): void {
  const stripped = stripOptional(typeExpr);
  const inner = stripped.inner;
  const isOptional = optional || stripped.optional;
  if (isOptional) {
    if (val === null || val === undefined) { w.push(0); return; }
    w.push(1);
  }
  switch (baseTypeFromExpr(inner)) {
    case 'bool':
      w.push(val ? 1 : 0);
      break;
    case 'int':
      w.pushI64LE(val as number | bigint);
      break;
    case 'uint':
      w.pushI64LE(val as number | bigint);
      break;
    case 'float':
      w.pushF64LE(Number(val));
      break;
    case 'str': {
      const bytes = textEncoder.encode(String(val));
      w.pushU32LE(bytes.length);
      w.pushBytes(bytes);
      break;
    }
    case 'list': {
      const itemExpr = inner.slice(1, -1).trim() || 'str';
      const items = Array.isArray(val) ? val : [];
      w.pushU32LE(items.length);
      for (const item of items) writeBinByTypeExpr(w, item, itemExpr);
      break;
    }
    case 'struct': {
      const fields = parseSchema(inner).fields;
      const obj = (val as AsonObj) ?? {};
      for (const f of fields) writeBinByTypeExpr(w, obj[f.name], f.typeExpr, f.optional);
      break;
    }
    case 'map': {
      const { valueExpr } = splitMapTypeExpr(inner);
      const entries = Object.entries((val as Record<string, unknown>) ?? {});
      w.pushU32LE(entries.length);
      for (const [k, v] of entries) {
        writeBinByTypeExpr(w, k, 'str');
        writeBinByTypeExpr(w, v, valueExpr || 'str');
      }
      break;
    }
  }
}

/** encodeBinary(obj) — schema is inferred internally */
export function encodeBinary(obj: AsonResult): Uint8Array {
  if (Array.isArray(obj)) {
    const fields = obj.length > 0 ? inferFields(obj[0]!) : [];
    const w = new BinWriter(obj.length * fields.length * 16 + 16);
    w.pushU32LE(obj.length);
    for (const row of obj) {
      for (const f of fields) writeBinByTypeExpr(w, row[f.name], f.typeExpr, f.optional);
    }
    return w.finish();
  } else {
    const o = obj as AsonObj;
    const fields = inferFields(o);
    const w = new BinWriter(fields.length * 16 + 16);
    for (const f of fields) writeBinByTypeExpr(w, o[f.name], f.typeExpr, f.optional);
    return w.finish();
  }
}

// ---------------------------------------------------------------------------
// decodeBinary(data, schema) — schema must be explicit (binary has no types embedded)
// ---------------------------------------------------------------------------

function readI64LE(dv: DataView, pos: number): number {
  const lo = dv.getUint32(pos, true);
  const hi = dv.getInt32(pos + 4, true);
  const big = (BigInt(hi) << 32n) | BigInt(lo);
  return Number(big);
}

function readU64LE(dv: DataView, pos: number): number {
  const lo = dv.getUint32(pos, true);
  const hi = dv.getUint32(pos + 4, true);
  const big = (BigInt(hi) << 32n) | BigInt(lo);
  return Number(big);
}

class BinDecoder {
  dv: DataView; pos: number;
  constructor(data: Uint8Array) { this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength); this.pos = 0; }
  err(msg: string): never { throw new AsonError(`binary decode: ${msg} at byte ${this.pos}`); }

  readStruct(fields: Field[]): AsonObj {
    const obj: AsonObj = {};
    for (const f of fields) obj[f.name] = this.readByTypeExpr(f.typeExpr, f.optional);
    return obj;
  }

  readByTypeExpr(typeExpr: string, optional = false): unknown {
    const stripped = stripOptional(typeExpr);
    const inner = stripped.inner;
    const isOptional = optional || stripped.optional;
    if (isOptional) {
      const tag = this.dv.getUint8(this.pos++);
      if (tag === 0) return null;
    }
    switch (baseTypeFromExpr(inner)) {
      case 'bool':  return this.dv.getUint8(this.pos++) !== 0;
      case 'int':   { const v = readI64LE(this.dv, this.pos); this.pos += 8; return v; }
      case 'uint':  { const v = readU64LE(this.dv, this.pos); this.pos += 8; return v; }
      case 'float': { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
      case 'str': {
        const len = this.dv.getUint32(this.pos, true); this.pos += 4;
        const bytes = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.pos, len);
        this.pos += len;
        return textDecoder.decode(bytes);
      }
      case 'list': {
        const count = this.dv.getUint32(this.pos, true); this.pos += 4;
        const itemExpr = inner.slice(1, -1).trim() || 'str';
        const out: unknown[] = [];
        for (let i = 0; i < count; i++) out.push(this.readByTypeExpr(itemExpr));
        return out;
      }
      case 'struct': {
        const fields = parseSchema(inner).fields;
        return this.readStruct(fields);
      }
      case 'map': {
        const count = this.dv.getUint32(this.pos, true); this.pos += 4;
        const { valueExpr } = splitMapTypeExpr(inner);
        const out: AsonObj = {};
        for (let i = 0; i < count; i++) {
          const key = this.readByTypeExpr('str') as string;
          out[key] = this.readByTypeExpr(valueExpr || 'str');
        }
        return out;
      }
    }
  }
}

export function decodeBinary(data: Uint8Array, schema: string): AsonResult {
  const { fields, isSlice } = parseSchema(schema);
  const bd = new BinDecoder(data);

  let result: AsonResult;
  if (isSlice) {
    const count = bd.dv.getUint32(bd.pos, true); bd.pos += 4;
    const rows: AsonObj[] = [];
    for (let i = 0; i < count; i++) rows.push(bd.readStruct(fields));
    result = rows;
  } else {
    result = bd.readStruct(fields);
  }

  if (bd.pos !== data.length) throw new AsonError(`binary decode: trailing bytes (read ${bd.pos}, total ${data.length})`);
  return result;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class AsonError extends Error {
  constructor(msg: string) { super(`ASON: ${msg}`); this.name = 'AsonError'; }
}
