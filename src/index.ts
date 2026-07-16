/**
 * ASUN (Array-Schema Unified Notation) — JavaScript/TypeScript runtime.
 *
 * API:
 *   encode(obj)                    → string
 *   encodeTyped(obj)               → string
 *   encodePretty(obj)              → string
 *   encodePrettyTyped(obj)         → string
 *   decode(text)                   → object | object[]
 *   encodeBinary(obj)              → Uint8Array
 *   decodeBinary(data, schema)     → object | object[]
 *
 * Rules:
 *   - Text schema uses `@` type annotations.
 *   - Complex fields must keep `@{...}` / `@[...]` structural markers.
 *   - Binary decode still requires an explicit schema because binary payloads
 *     do not embed type information.
 */

export type AsunObj = Record<string, unknown>;
export type AsunResult = AsunObj | AsunObj[];

type BaseType = "int" | "float" | "bool" | "str" | "list" | "struct" | "auto";

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

const NEEDS_QUOTE = new Uint8Array(256);
for (let i = 0; i < 33; i++) NEEDS_QUOTE[i] = 1; // 0x00..=0x1f and 0x20
NEEDS_QUOTE[0x7f] = 1;
for (const ch of [",", "@", "(", ")", "[", "]", "{", "}", ":", "<", ">", "/", "*", '"', "\\"]) {
  NEEDS_QUOTE[ch.charCodeAt(0)] = 1;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Assign a decoded field onto a result object. Plain assignment with a
// user-controlled key of "__proto__" would mutate the object's prototype
// instead of creating an own property (prototype pollution); defineProperty
// always creates an own, enumerable data property regardless of the key.
function setField(obj: AsunObj, key: string, value: unknown): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

const _f64Buf = new ArrayBuffer(8);
const _f64View = new DataView(_f64Buf);
const _f64Bytes = new Uint8Array(_f64Buf);

const _schemaCache = new Map<string, ParsedSchema>();

function isPlainObject(value: unknown): value is AsunObj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ASCII-only trim — preserves Unicode characters like U+FEFF (BOM) that
// String.prototype.trim() would strip as Unicode whitespace.
function trimAsciiWs(s: string): string {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const c = s.charCodeAt(lo);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) lo++;
    else break;
  }
  while (hi > lo) {
    const c = s.charCodeAt(hi - 1);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) hi--;
    else break;
  }
  return lo === 0 && hi === s.length ? s : s.slice(lo, hi);
}

function inferBaseType(val: unknown): BaseType {
  if (typeof val === "boolean") return "bool";
  if (typeof val === "number") return Number.isInteger(val) ? "int" : "float";
  if (typeof val === "bigint") return "int";
  if (Array.isArray(val)) return "list";
  if (isPlainObject(val)) return "struct";
  return "str";
}

function baseTypeFromExpr(typeExpr: string): BaseType {
  if (typeExpr === "auto") return "auto";
  if (typeExpr.startsWith("[")) return "list";
  if (typeExpr.startsWith("{")) return "struct";
  if (
    typeExpr === "int" ||
    typeExpr === "float" ||
    typeExpr === "bool" ||
    typeExpr === "str"
  ) {
    return typeExpr;
  }
  throw new AsunError(`unknown type '${typeExpr}'`);
}

function stripOptional(typeExpr: string): { inner: string; optional: boolean } {
  return typeExpr.endsWith("?")
    ? { inner: typeExpr.slice(0, -1), optional: true }
    : { inner: typeExpr, optional: false };
}

function unifyTypeExpr(a: string, b: string): string {
  if (a === b) return a;
  if ((a === "int" && b === "float") || (a === "float" && b === "int"))
    return "float";
  return "str";
}

function inferStructTypeExpr(sample: AsunObj): string {
  const parts = Object.keys(sample).map((name) => {
    const value = sample[name];
    const optional = value === null || value === undefined;
    const typeExpr = optional ? "str" : inferValueTypeExpr(value);
    return `${encodeSchemaFieldName(name)}@${optional ? `${typeExpr}?` : typeExpr}`;
  });
  return `{${parts.join(",")}}`;
}

function inferValueTypeExpr(val: unknown): string {
  if (val === null || val === undefined) return "str";
  if (typeof val === "boolean") return "bool";
  if (typeof val === "number") return Number.isInteger(val) ? "int" : "float";
  if (typeof val === "bigint") return "int";
  if (typeof val === "string") return "str";
  if (Array.isArray(val)) {
    let elemExpr = "str";
    let hasNonNull = false;
    let optional = false;
    for (const item of val) {
      if (item === null || item === undefined) {
        optional = true;
        continue;
      }
      const cur = inferValueTypeExpr(item);
      elemExpr = hasNonNull ? unifyTypeExpr(elemExpr, cur) : cur;
      hasNonNull = true;
    }
    if (!hasNonNull) elemExpr = "str";
    if (optional && !elemExpr.endsWith("?")) elemExpr += "?";
    return `[${elemExpr}]`;
  }
  if (isPlainObject(val)) return inferStructTypeExpr(val);
  return "str";
}

function inferFields(sample: AsunObj): Field[] {
  return Object.keys(sample).map((name) => {
    const value = sample[name];
    const optional = value === null || value === undefined;
    const typeExpr = optional ? "str" : inferValueTypeExpr(value);
    return {
      name,
      base: baseTypeFromExpr(stripOptional(typeExpr).inner),
      optional,
      typeExpr,
    };
  });
}

function parseSchema(schema: string): ParsedSchema {
  const cached = _schemaCache.get(schema);
  if (cached) return cached;
  const parsed = parseSchemaInner(schema);
  _schemaCache.set(schema, parsed);
  return parsed;
}

function parseSchemaInner(schema: string): ParsedSchema {
  let pos = 0;
  const n = schema.length;

  const skip = () => {
    while (
      pos < n &&
      (schema[pos] === " " ||
        schema[pos] === "\t" ||
        schema[pos] === "\n" ||
        schema[pos] === "\r")
    )
      pos++;
  };

  skip();
  let isSlice = false;
  if (pos < n && schema[pos] === "[") {
    isSlice = true;
    pos++;
  }

  skip();
  if (pos >= n || schema[pos] !== "{")
    throw new AsunError(`expected '{' in schema`);
  const scannedStruct = scanStructSchema(schema, pos);
  pos = scannedStruct.end;

  if (isSlice) {
    skip();
    if (pos >= n || schema[pos] !== "]")
      throw new AsunError(`expected ']' after schema`);
    pos++;
  }

  skip();
  if (pos !== n) throw new AsunError(`unexpected trailing schema content`);
  return { fields: scannedStruct.fields, isSlice };
}

function scanStructSchema(
  src: string,
  start: number,
): { fields: Field[]; end: number } {
  let pos = start;
  const n = src.length;
  if (src[pos] !== "{") throw new AsunError(`expected '{' in schema`);
  pos++;

  const skip = () => {
    while (
      pos < n &&
      (src[pos] === " " ||
        src[pos] === "\t" ||
        src[pos] === "\n" ||
        src[pos] === "\r")
    )
      pos++;
  };

  const fields: Field[] = [];
  while (pos < n) {
    skip();
    if (src[pos] === "}") {
      pos++;
      break;
    }
    if (fields.length > 0) {
      if (src[pos] !== ",") throw new AsunError(`expected ',' in schema`);
      pos++;
      skip();
    }

    let name = "";
    if (src[pos] === '"') {
      const parsed = parseSchemaQuotedName(src, pos);
      name = parsed.name;
      pos = parsed.end;
    } else {
      const ns = pos;
      while (
        pos < n &&
        src[pos] !== "@" &&
        src[pos] !== "," &&
        src[pos] !== "}" &&
        src[pos] !== ":" &&
        src[pos] !== " " &&
        src[pos] !== "\t" &&
        src[pos] !== "\n" &&
        src[pos] !== "\r"
      ) {
        pos++;
      }
      name = src.slice(ns, pos);
      if (!name) throw new AsunError(`empty field name in schema`);
    }

    skip();
    let typeExpr = "auto";
    if (pos < n && src[pos] === "@") {
      pos++;
      skip();
      const scanned = scanTypeExpr(src, pos);
      typeExpr = scanned.typeExpr;
      pos = scanned.end;
    }

    const stripped = stripOptional(typeExpr);
    const base = baseTypeFromExpr(stripped.inner);
    fields.push({
      name,
      base,
      optional: stripped.optional,
      typeExpr: stripped.inner,
    });
  }

  return { fields, end: pos };
}

function parseSchemaQuotedName(
  src: string,
  start: number,
): { name: string; end: number } {
  let pos = start + 1;
  const parts: string[] = [];
  while (pos < src.length) {
    const c = src[pos]!;
    if (c === '"') {
      return { name: parts.join(""), end: pos + 1 };
    }
    if (c === "\\") {
      pos++;
      if (pos >= src.length)
        throw new AsunError(`unterminated quoted field name in schema`);
      const esc = src[pos]!;
      if (esc === '"') parts.push('"');
      else if (esc === "\\") parts.push("\\");
      else if (esc === "n") parts.push("\n");
      else if (esc === "r") parts.push("\r");
      else if (esc === "t") parts.push("\t");
      else if (esc === "b") parts.push("\b");
      else if (esc === "f") parts.push("\f");
      else parts.push(esc);
      pos++;
      continue;
    }
    parts.push(c);
    pos++;
  }
  throw new AsunError(`unterminated quoted field name in schema`);
}

function scanBalanced(
  src: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let pos = start; pos < src.length; pos++) {
    const c = src[pos]!;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return pos + 1;
    }
  }
  throw new AsunError(`unterminated '${open}${close}' block in schema`);
}

function scanTypeExpr(
  src: string,
  start: number,
): { typeExpr: string; end: number } {
  if (start >= src.length) return { typeExpr: "str", end: start };
  const c = src[start]!;
  if (c === "<") throw new AsunError(`unsupported schema syntax`);
  if (c === "{") {
    let end = scanBalanced(src, start, "{", "}");
    if (src[end] === "?") end++;
    return { typeExpr: src.slice(start, end), end };
  }
  if (c === "[") {
    let end = scanBalanced(src, start, "[", "]");
    if (src[end] === "?") end++;
    return { typeExpr: src.slice(start, end), end };
  }

  let end = start;
  while (
    end < src.length &&
    src[end] !== "," &&
    src[end] !== "}" &&
    src[end] !== " " &&
    src[end] !== "\t" &&
    src[end] !== "\n" &&
    src[end] !== "\r"
  ) {
    if (src[end] === "<")
      throw new AsunError(`unsupported schema syntax`);
    end++;
  }
  return { typeExpr: src.slice(start, end), end };
}

function typeExprToUntyped(typeExpr: string): string | null {
  const stripped = stripOptional(typeExpr);
  const inner = stripped.inner;
  if (!inner.startsWith("{") && !inner.startsWith("[")) return null;

  if (inner.startsWith("{")) {
    const fields = parseSchema(inner).fields;
    const rendered = fields
      .map((field) => {
        const nested = typeExprToUntyped(
          field.optional ? `${field.typeExpr}?` : field.typeExpr,
        );
        const suffix = nested ? `@${nested}` : "";
        const optional = nested && field.optional ? "?" : "";
        return `${field.name}${suffix}${optional}`;
      })
      .join(",");
    return `{${rendered}}${stripped.optional ? "?" : ""}`;
  }

  const innerExpr = inner.slice(1, -1).trim();
  const nested = innerExpr ? typeExprToUntyped(innerExpr) : null;
  return `[${nested ?? ""}]${stripped.optional ? "?" : ""}`;
}

function renderFieldHeader(field: Field, typed: boolean): string {
  const name = encodeSchemaFieldName(field.name);
  if (typed) {
    return `${name}@${field.typeExpr}${field.optional ? "?" : ""}`;
  }
  const nested = typeExprToUntyped(
    field.optional ? `${field.typeExpr}?` : field.typeExpr,
  );
  return nested ? `${name}@${nested}` : name;
}

function buildHeader(
  fields: Field[],
  isSlice: boolean,
  typed: boolean,
): string {
  const inner = `{${fields.map((field) => renderFieldHeader(field, typed)).join(",")}}`;
  return isSlice ? `[${inner}]` : inner;
}

function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (s === "true" || s === "false" || s === "True" || s === "False" || s === "TRUE" || s === "FALSE") return true;
  const c0 = s.charCodeAt(0);
  const cN = s.charCodeAt(s.length - 1);
  // Leading/trailing ASCII whitespace forces quoting (SPEC §S2 trim).
  if (c0 === 0x20 || c0 === 0x09 || c0 === 0x0A || c0 === 0x0D) return true;
  if (cN === 0x20 || cN === 0x09 || cN === 0x0A || cN === 0x0D) return true;
  for (let i = 0; i < s.length; i++) {
    if (NEEDS_QUOTE[s.charCodeAt(i)]) return true;
  }
  // Number-like prefix forces quoting.
  if (c0 >= 0x30 && c0 <= 0x39) return true;
  if ((c0 === 0x2d || c0 === 0x2b) && s.length >= 2) {
    const c1 = s.charCodeAt(1);
    if (c1 >= 0x30 && c1 <= 0x39) return true;
  }
  if (c0 === 0x2e && s.length >= 2) {
    const c1 = s.charCodeAt(1);
    if (c1 >= 0x30 && c1 <= 0x39) return true;
  }
  return false;
}

function needsQuotedSchemaFieldName(name: string): boolean {
  if (name.length === 0) return true;
  if (name === "true" || name === "false") return true;
  if (name[0] === " " || name[name.length - 1] === " ") return true;
  let couldBeNum = true;
  const numStart = name[0] === "-" ? 1 : 0;
  if (numStart >= name.length) couldBeNum = false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (
      c < 32 ||
      c === 32 ||
      c === 9 ||
      c === 10 ||
      c === 13 ||
      c === 44 ||
      c === 64 ||
      c === 58 ||
      c === 123 ||
      c === 125 ||
      c === 91 ||
      c === 93 ||
      c === 40 ||
      c === 41 ||
      c === 34 ||
      c === 92
    ) {
      return true;
    }
    if (couldBeNum && i >= numStart && !((c >= 48 && c <= 57) || c === 46)) {
      couldBeNum = false;
    }
  }
  return couldBeNum && name.length > numStart;
}

function encodeSchemaFieldName(name: string): string {
  return needsQuotedSchemaFieldName(name) ? quoteStr(name) : name;
}

function quoteStr(s: string): string {
  const parts: string[] = ['"'];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const cc = s.charCodeAt(i);
    if (c === '"') parts.push('\\"');
    else if (c === "\\") parts.push("\\\\");
    else if (c === "\n") parts.push("\\n");
    else if (c === "\r") parts.push("\\r");
    else if (c === "\t") parts.push("\\t");
    else if (c === "\b") parts.push("\\b");
    else if (c === "\f") parts.push("\\f");
    else if (cc < 0x20 || cc === 0x7f)
      parts.push("\\u00" + cc.toString(16).padStart(2, "0"));
    else parts.push(c);
  }
  parts.push('"');
  return parts.join("");
}

function encodeStr(s: string): string {
  return needsQuoting(s) ? quoteStr(s) : s;
}

function formatFloat(v: number): string {
  if (!isFinite(v)) {
    throw new AsunError(
      `cannot encode non-finite float (NaN/Infinity)`,
    );
  }
  if (Object.is(v, -0)) return "0";
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(1);
  // Default JS formatting handles scientific notation for very large/small
  // magnitudes and is round-trippable via Number.parseFloat.
  let s = String(v);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

function encodeGenericValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number")
    return Number.isInteger(val) ? String(val) : formatFloat(val);
  if (typeof val === "bigint") return String(val);
  if (typeof val === "string") return encodeStr(val);
  if (Array.isArray(val)) {
    return `[${val.map((item) => encodeGenericValue(item)).join(", ")}]`;
  }
  if (isPlainObject(val)) {
    return encodeByTypeExpr(val, inferValueTypeExpr(val));
  }
  return encodeStr(String(val));
}

function encodeByTypeExpr(
  val: unknown,
  typeExpr: string,
  optional = false,
): string {
  const stripped = stripOptional(typeExpr);
  const inner = stripped.inner;
  const isOptional = optional || stripped.optional;
  if (isOptional && (val === null || val === undefined)) return "";

  switch (baseTypeFromExpr(inner)) {
    case "auto": {
      const base = inferBaseType(val);
      return encodeByTypeExpr(val, base, isOptional);
    }
    case "bool":
      return val ? "true" : "false";
    case "int":
      return String(typeof val === "bigint" ? val : Math.trunc(Number(val)));
    case "float":
      return formatFloat(Number(val));
    case "str":
      return encodeStr(String(val ?? ""));
    case "list": {
      const itemExpr = inner.slice(1, -1).trim() || "str";
      const items = Array.isArray(val) ? val : [];
      return `[${items.map((item) => encodeByTypeExpr(item, itemExpr)).join(", ")}]`;
    }
    case "struct": {
      const fields = parseSchema(inner).fields;
      return encodeTuple((val as AsunObj) ?? {}, fields);
    }
  }
}

function encodeTuple(obj: AsunObj, fields: Field[]): string {
  let out = "(";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) out += ",";
    const field = fields[i]!;
    out += encodeByTypeExpr(obj[field.name], field.typeExpr, field.optional);
  }
  return `${out})`;
}

// Untyped value encoder: scalar / null / plain array (without struct items).
function encodeUntyped(val: unknown): string {
  if (val === null || val === undefined) return "()";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return String(val);
    return formatFloat(val);
  }
  if (typeof val === "bigint") return String(val);
  if (typeof val === "string") return encodeStr(val);
  if (Array.isArray(val)) {
    return `[${val.map((item) => encodeUntyped(item)).join(",")}]`;
  }
  // Fallback: stringify
  return encodeStr(String(val));
}

function isPlainObjectArray(val: unknown): boolean {
  if (!Array.isArray(val)) return false;
  if (val.length === 0) return false;
  return isPlainObject(val[0]);
}

export function encode(obj: AsunResult): string {
  // Untyped fallback for scalars / nulls / plain arrays / strings.
  if (
    obj === null ||
    obj === undefined ||
    typeof obj === "boolean" ||
    typeof obj === "number" ||
    typeof obj === "bigint" ||
    typeof obj === "string" ||
    (Array.isArray(obj) && !isPlainObjectArray(obj))
  ) {
    return encodeUntyped(obj);
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[{}]:\n";
    const fields = inferFields(obj[0]!);
    const header = buildHeader(fields, true, false);
    let out = `${header}:\n`;
    for (let i = 0; i < obj.length; i++) {
      out += encodeTuple(obj[i]!, fields);
      if (i < obj.length - 1) out += ",\n";
    }
    return `${out}\n`;
  }

  const fields = inferFields(obj);
  const header = buildHeader(fields, false, false);
  return `${header}:\n${encodeTuple(obj, fields)}\n`;
}

export function encodeTyped(obj: AsunResult): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[{}]:\n";
    const fields = inferFields(obj[0]!);
    const header = buildHeader(fields, true, true);
    let out = `${header}:\n`;
    for (let i = 0; i < obj.length; i++) {
      out += encodeTuple(obj[i]!, fields);
      if (i < obj.length - 1) out += ",\n";
    }
    return `${out}\n`;
  }

  const fields = inferFields(obj);
  const header = buildHeader(fields, false, true);
  return `${header}:\n${encodeTuple(obj, fields)}\n`;
}

export function encodePretty(obj: AsunResult): string {
  return prettyFormat(encode(obj));
}

export function encodePrettyTyped(obj: AsunResult): string {
  return prettyFormat(encodeTyped(obj));
}

const PRETTY_MAX_WIDTH = 100;

function buildMatchTable(src: string): Int32Array {
  const match = new Int32Array(src.length).fill(-1);
  const stack: number[] = [];
  let inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
      }
    }
  }
  return match;
}

function prettyFormat(src: string): string {
  const match = buildMatchTable(src);
  const fmt = new PrettyFmt(src, match);
  fmt.writeTop();
  return fmt.out;
}

class PrettyFmt {
  src: string;
  match: Int32Array;
  out = "";
  pos = 0;
  depth = 0;

  constructor(src: string, match: Int32Array) {
    this.src = src;
    this.match = match;
  }

  indent(): string {
    return "  ".repeat(this.depth);
  }

  isSimple(start: number, end: number): boolean {
    return (
      end - start <= PRETTY_MAX_WIDTH &&
      !this.src.slice(start, end + 1).includes("\n")
    );
  }

  writeTop(): void {
    let depth = 0;
    let inQuote = false;
    let sep = -1;
    for (let i = 0; i < this.src.length; i++) {
      const c = this.src[i]!;
      if (inQuote) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === '"') inQuote = false;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
      else if (c === ":" && depth === 0) {
        sep = i;
        break;
      }
    }

    if (sep === -1) {
      this.out = this.src;
      return;
    }

    this.out += this.src.slice(0, sep + 1);
    this.pos = sep + 1;
    this.skipNewlines();
    this.out += "\n";

    while (this.pos < this.src.length) {
      this.skipWhitespaceAndCommas();
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === "(") {
        const close = this.match[this.pos];
        if (close !== -1 && !this.isSimple(this.pos, close)) this.writeTuple();
        else {
          while (this.pos <= close) this.out += this.src[this.pos++]!;
        }
        this.skipWhitespace();
        if (this.pos < this.src.length && this.src[this.pos] === ",") {
          this.out += ",\n";
          this.pos++;
        } else {
          this.out += "\n";
        }
      } else {
        this.out += this.src[this.pos++]!;
      }
    }
  }

  writeTuple(): void {
    this.out += "(\n";
    this.pos++;
    this.depth++;
    let first = true;
    while (this.pos < this.src.length && this.src[this.pos] !== ")") {
      this.skipWhitespace();
      if (this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (!first) this.out += ",\n";
      first = false;
      this.out += this.indent();
      this.writeValue();
    }
    this.depth--;
    this.out += `\n${this.indent()})`;
    if (this.pos < this.src.length) this.pos++;
  }

  writeList(): void {
    this.out += "[\n";
    this.pos++;
    this.depth++;
    let first = true;
    while (this.pos < this.src.length && this.src[this.pos] !== "]") {
      this.skipWhitespace();
      if (this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (!first) this.out += ",\n";
      first = false;
      this.out += this.indent();
      this.writeValue();
    }
    this.depth--;
    this.out += `\n${this.indent()}]`;
    if (this.pos < this.src.length) this.pos++;
  }

  writeValue(): void {
    if (this.pos >= this.src.length) return;
    const c = this.src[this.pos]!;
    if (c === "(" || c === "[") {
      const close = this.match[this.pos];
      if (close !== -1 && !this.isSimple(this.pos, close)) {
        if (c === "(") this.writeTuple();
        else this.writeList();
      } else {
        while (this.pos <= close) this.out += this.src[this.pos++]!;
      }
      return;
    }
    if (c === '"') {
      this.out += this.src[this.pos++]!;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos]!;
        this.out += ch;
        this.pos++;
        if (ch === "\\") {
          this.out += this.src[this.pos++] ?? "";
          continue;
        }
        if (ch === '"') break;
      }
      return;
    }
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      // ',' 0x2c, ')' 0x29, ']' 0x5d
      if (c === 0x2c || c === 0x29 || c === 0x5d) break;
      this.out += this.src[this.pos++]!;
    }
  }

  skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.pos++;
    }
  }

  skipNewlines(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c !== 0x0a && c !== 0x0d) break;
      this.pos++;
    }
  }

  skipWhitespaceAndCommas(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x2c) break;
      this.pos++;
    }
  }
}

export function decode(text: string): AsunResult {
  return new Decoder(text).decodeTop();
}

class Decoder {
  src: string;
  pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  err(msg: string): never {
    throw new AsunError(`${msg} at pos ${this.pos}`);
  }

  /** True if `pos` is at end-of-input or at a value-position terminator
   *  (`,` `)` `]`). Hot — uses charCode to avoid the per-char allocation
   *  that `this.src[pos]` and `[...].includes()` would trigger in V8. */
  private atValueEnd(): boolean {
    if (this.pos >= this.src.length) return true;
    const c = this.src.charCodeAt(this.pos);
    return c === 0x2c /* , */ || c === 0x29 /* ) */ || c === 0x5d /* ] */;
  }

  skip(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.pos++;
        continue;
      }
      // '/' '*' = 0x2f 0x2a — block comment opener.
      if (
        c === 0x2f &&
        this.src.charCodeAt(this.pos + 1) === 0x2a
      ) {
        this.pos += 2;
        while (
          this.pos + 1 < this.src.length &&
          !(
            this.src.charCodeAt(this.pos) === 0x2a &&
            this.src.charCodeAt(this.pos + 1) === 0x2f
          )
        )
          this.pos++;
        this.pos += 2;
        continue;
      }
      break;
    }
  }

  decodeTop(): AsunResult {
    this.skip();
    const isSlice =
      this.src[this.pos] === "[" && this.src[this.pos + 1] === "{";
    const isStruct = this.src[this.pos] === "{";

    // SPEC §8.3 untyped top level: `[...]` plain array, or bare value.
    // Top-level `(...)` is not allowed, except `()` is the untyped null marker.
    if (!isSlice && !isStruct) {
      if (this.pos >= this.src.length) this.err(`empty input`);
      if (this.src[this.pos] === "(") {
        if (this.src[this.pos + 1] === ")") {
          this.pos += 2;
          this.skip();
          if (this.pos < this.src.length)
            this.err(`trailing content after decoded value`);
          return null as unknown as AsunResult;
        }
        this.err(`bare tuple at top level — schema required`);
      }
      const out =
        this.src[this.pos] === "["
          ? this.parseList()
          : this.parseGenericValue();
      this.skip();
      if (this.pos < this.src.length)
        this.err(`trailing content after decoded value`);
      return out as AsunResult;
    }

    if (isSlice) this.pos++;

    if (this.src[this.pos] !== "{") this.err(`expected '{'`);
    const { fields, end } = scanStructSchema(this.src, this.pos);
    this.pos = end;

    this.skip();
    if (isSlice) {
      if (this.src[this.pos] !== "]") this.err(`expected ']'`);
      this.pos++;
    }

    this.skip();
    if (this.src[this.pos] !== ":") this.err(`expected ':'`);
    this.pos++;

    if (isSlice) {
      const rows: AsunObj[] = [];
      while (true) {
        this.skip();
        if (this.pos >= this.src.length || this.src[this.pos] !== "(") break;
        rows.push(this.parseTuple(fields));
        this.skip();
        if (this.src[this.pos] === ",") this.pos++;
      }
      this.skip();
      if (this.pos < this.src.length)
        this.err(`trailing content after decoded value`);
      return rows;
    }

    this.skip();
    const obj = this.parseTuple(fields);
    this.skip();
    if (this.pos < this.src.length)
      this.err(`trailing content after decoded value`);
    return obj;
  }

  parseTuple(fields: Field[]): AsunObj {
    if (this.src.charCodeAt(this.pos) !== 0x28 /* ( */) this.err(`expected '('`);
    this.pos++;
    const obj: AsunObj = {};

    for (let i = 0; i < fields.length; i++) {
      this.skip();
      if (i > 0) {
        if (this.src.charCodeAt(this.pos) !== 0x2c /* , */) this.err(`expected ','`);
        this.pos++;
        this.skip();
      }
      const field = fields[i]!;
      if (this.pos >= this.src.length) {
        setField(obj, field.name, null);
        continue;
      }
      const cc = this.src.charCodeAt(this.pos);
      if (cc === 0x29 /* ) */ || cc === 0x2c /* , */) {
        setField(obj, field.name, null);
        continue;
      }
      setField(obj, field.name, this.parseTypeExpr(field.typeExpr, field.optional));
    }

    this.skip();
    if (this.src.charCodeAt(this.pos) !== 0x29 /* ) */) this.err(`expected ')'`);
    this.pos++;
    return obj;
  }

  parseTypeExpr(typeExpr: string, optional = false): unknown {
    this.skip();
    const stripped = stripOptional(typeExpr);
    const inner = stripped.inner;
    const isOptional = optional || stripped.optional;
    if (this.atValueEnd()) return null;

    switch (baseTypeFromExpr(inner)) {
      case "auto":
        return this.parseGenericValue();
      case "bool":
        return this.parseBool();
      case "int":
        return this.parseInt();
      case "float":
        return this.parseFloat();
      case "str": {
        const value = this.parseString();
        return value === "" && isOptional ? null : value;
      }
      case "list": {
        const itemExpr = inner.slice(1, -1).trim() || "str";
        return this.parseList(itemExpr);
      }
      case "struct":
        return this.parseTuple(parseSchema(inner).fields);
    }
  }

  parseGenericValue(): unknown {
    this.skip();
    if (this.atValueEnd()) return null;
    const cc = this.src.charCodeAt(this.pos);
    if (cc === 0x22 /* " */) return this.parseQuotedString();
    if (cc === 0x3c /* < */) this.err(`unsupported value syntax`);
    if (cc === 0x5b /* [ */) return this.parseList();
    if (cc === 0x28 /* ( */) {
      // `()` is the untyped null marker.
      if (this.src.charCodeAt(this.pos + 1) === 0x29 /* ) */) {
        this.pos += 2;
        return null;
      }
      return this.parseGenericTuple();
    }
    if (
      this.src.startsWith("true", this.pos) ||
      this.src.startsWith("false", this.pos)
    )
      return this.parseBool();
    const token = trimAsciiWs(this.parsePlainToken());
    if (token === "") return null;
    const scalar = parseScalarToken(token);
    if (scalar !== undefined) return scalar;
    return token.includes("\\") ? unescapePlain(token) : token;
  }

  /** Scan a plain (unquoted) token until the next top-level value
   *  terminator (`,` `)` `]`). Tracks paren/bracket depth so `(1,2,3)` and
   *  `[1,2,3]` inside a token don't split early. Hot path: charCode-based,
   *  no per-char string allocations. */
  parsePlainToken(): string {
    const start = this.pos;
    let depthParen = 0;
    let depthBracket = 0;
    let inQuote = false;

    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (inQuote) {
        if (c === 0x5c /* \ */) {
          this.pos += 2;
          continue;
        }
        this.pos++;
        if (c === 0x22 /* " */) inQuote = false;
        continue;
      }
      if (c === 0x22 /* " */) {
        inQuote = true;
        this.pos++;
        continue;
      }
      if (c === 0x28 /* ( */) depthParen++;
      else if (c === 0x29 /* ) */) {
        if (depthParen === 0) break;
        depthParen--;
      } else if (c === 0x5b /* [ */) depthBracket++;
      else if (c === 0x5d /* ] */) {
        if (depthBracket === 0) break;
        depthBracket--;
      } else if (c === 0x2c /* , */ && depthParen === 0 && depthBracket === 0) {
        break;
      }
      if (c === 0x5c /* \ */) this.pos += 2;
      else this.pos++;
    }

    return this.src.slice(start, this.pos);
  }

  parseGenericTuple(): unknown[] {
    if (this.src.charCodeAt(this.pos) !== 0x28 /* ( */) this.err(`expected '('`);
    this.pos++;
    const out: unknown[] = [];
    while (this.pos < this.src.length) {
      this.skip();
      if (this.src.charCodeAt(this.pos) === 0x29 /* ) */) {
        this.pos++;
        break;
      }
      out.push(this.parseGenericValue());
      this.skip();
      if (this.src.charCodeAt(this.pos) === 0x2c /* , */) this.pos++;
    }
    return out;
  }

  parseList(itemTypeExpr?: string): unknown[] {
    if (this.src.charCodeAt(this.pos) !== 0x5b /* [ */) this.err(`expected '['`);
    this.pos++;
    const out: unknown[] = [];
    while (this.pos < this.src.length) {
      this.skip();
      if (this.src.charCodeAt(this.pos) === 0x5d /* ] */) {
        this.pos++;
        break;
      }
      out.push(
        itemTypeExpr
          ? this.parseTypeExpr(itemTypeExpr)
          : this.parseGenericValue(),
      );
      this.skip();
      if (this.src.charCodeAt(this.pos) === 0x2c /* , */) this.pos++;
    }
    return out;
  }

  parseBool(): boolean {
    if (this.src.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    this.err(`invalid bool`);
  }

  parseInt(): number | bigint | null {
    if (this.atValueEnd()) return null;
    const tokenStart = this.pos;
    if (this.src.charCodeAt(this.pos) === 0x2d /* - */) this.pos++;
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c < 48 || c > 57) break;
      this.pos++;
    }
    if (this.pos === start) this.err(`invalid int`);
    const token = this.src.slice(tokenStart, this.pos);
    const n = Number(token);
    // Beyond 2^53 a double can no longer represent every integer exactly;
    // preserve int64-range precision by returning a BigInt instead.
    if (!Number.isSafeInteger(n)) return BigInt(token);
    return n;
  }

  parseFloat(): number | null {
    if (this.atValueEnd()) return null;
    const start = this.pos;
    if (this.src.charCodeAt(this.pos) === 0x2d /* - */) this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c < 0x30 || c > 0x39) break;
      this.pos++;
    }
    if (this.src.charCodeAt(this.pos) === 0x2e /* . */) {
      this.pos++;
      while (this.pos < this.src.length) {
        const c = this.src.charCodeAt(this.pos);
        if (c < 0x30 || c > 0x39) break;
        this.pos++;
      }
    }
    if (this.pos === start) this.err(`invalid float`);
    return Number.parseFloat(this.src.slice(start, this.pos));
  }

  parseString(): string {
    if (this.src.charCodeAt(this.pos) === 0x22 /* " */) return this.parseQuotedString();
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 0x2c /* , */ || c === 0x29 /* ) */ || c === 0x5d /* ] */) break;
      if (c === 0x5c /* \ */) this.pos += 2;
      else this.pos++;
    }
    const raw = trimAsciiWs(this.src.slice(start, this.pos));
    if (raw === "") return "";
    return raw.includes("\\") ? unescapePlain(raw) : raw;
  }

  parseQuotedString(): string {
    this.pos++; // consume opening "
    const start = this.pos;

    // Fast path: scan for `"` or `\` without building any intermediate
    // strings. If the string has no escapes, return a single slice — V8
    // makes this a SlicedString (no copy) in many cases.
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 0x22 /* " */) {
        const out = this.src.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c === 0x5c /* \ */) break; // fall through to slow path
      this.pos++;
    }

    if (this.pos >= this.src.length) {
      // Unterminated; emit what we have for caller-side error consistency.
      return this.src.slice(start, this.pos);
    }

    // Slow path: at least one backslash. Capture the prefix already scanned,
    // then append byte-by-byte while interpreting escapes.
    let out = this.src.slice(start, this.pos);
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos++);
      if (c === 0x22 /* " */) break;
      if (c === 0x5c /* \ */) {
        const esc = this.src.charCodeAt(this.pos++);
        if (esc === 0x6e /* n */) out += "\n";
        else if (esc === 0x72 /* r */) out += "\r";
        else if (esc === 0x74 /* t */) out += "\t";
        else if (esc === 0x62 /* b */) out += "\b";
        else if (esc === 0x66 /* f */) out += "\f";
        else if (esc === 0x75 /* u */) {
          const hex = this.src.slice(this.pos, this.pos + 4);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex))
            this.err(`invalid unicode escape`);
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
        } else {
          out += String.fromCharCode(esc);
        }
      } else {
        out += String.fromCharCode(c);
      }
    }
    return out;
  }
}

function parseScalarToken(
  token: string,
): string | number | bigint | boolean | undefined {
  if (token === "true") return true;
  if (token === "false") return false;

  // ABNF: number = ["-"] 1*DIGIT [ "." 1*DIGIT ] [ ("e"/"E") ["+"/"-"] 1*DIGIT ]
  // Leading "+" is forbidden; both fractional and exponent parts (if present)
  // require at least one digit.
  let i = 0;
  if (token[0] === "-") i = 1;

  // Integer part — must have ≥1 digit.
  const intStart = i;
  while (i < token.length) {
    const c = token.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === intStart) return undefined;

  let seenDot = false;
  let seenExp = false;

  if (i < token.length && token.charCodeAt(i) === 46) {
    i++;
    const fracStart = i;
    while (i < token.length) {
      const c = token.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (i === fracStart) return undefined;
    seenDot = true;
  }

  if (i < token.length) {
    const c = token.charCodeAt(i);
    if (c === 0x65 || c === 0x45) {
      i++;
      if (i < token.length) {
        const sign = token.charCodeAt(i);
        if (sign === 0x2b || sign === 0x2d) i++;
      }
      const expStart = i;
      while (i < token.length) {
        const cd = token.charCodeAt(i);
        if (cd < 48 || cd > 57) break;
        i++;
      }
      if (i === expStart) return undefined;
      seenExp = true;
    }
  }

  if (i !== token.length) return undefined;
  if (seenDot || seenExp) return Number.parseFloat(token);
  const n = Number(token);
  // Preserve int64-range precision for integers beyond the safe double range.
  if (!Number.isSafeInteger(n)) return BigInt(token);
  return n;
}

function unescapePlain(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      const c = s[i]!;
      if (c === "n") out += "\n";
      else if (c === "r") out += "\r";
      else if (c === "t") out += "\t";
      else if (c === "b") out += "\b";
      else if (c === "f") out += "\f";
      else if (c === "u") {
        const hex = s.slice(i + 1, i + 5);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += c;
        }
      }
      else out += c;
    } else {
      out += s[i]!;
    }
  }
  return out;
}

class BinWriter {
  buf: Uint8Array;
  len = 0;

  constructor(cap: number) {
    this.buf = new Uint8Array(cap);
  }

  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let next = Math.max(this.buf.length, 64);
    while (next < this.len + need) next *= 2;
    const out = new Uint8Array(next);
    out.set(this.buf.subarray(0, this.len));
    this.buf = out;
  }

  push(byte: number): void {
    this.grow(1);
    this.buf[this.len++] = byte;
  }

  // LEB128 unsigned varint.
  pushUvarint(value: number | bigint): void {
    let v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    v &= 0xffffffffffffffffn; // treat as unsigned 64-bit
    while (v >= 0x80n) {
      this.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.push(Number(v));
  }

  // zigzag + LEB128 signed varint.
  pushIvarint(value: number | bigint): void {
    const v =
      typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    const zig = ((v << 1n) ^ (v >> 63n)) & 0xffffffffffffffffn;
    this.pushUvarint(zig);
  }

  pushF64LE(value: number): void {
    this.grow(8);
    _f64View.setFloat64(0, value, true);
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

function writeBinByTypeExpr(
  writer: BinWriter,
  value: unknown,
  typeExpr: string,
  optional = false,
): void {
  const stripped = stripOptional(typeExpr);
  const inner = stripped.inner;
  const isOptional = optional || stripped.optional;
  if (isOptional) {
    if (value === null || value === undefined) {
      writer.push(0);
      return;
    }
    writer.push(1);
  }

  switch (baseTypeFromExpr(inner)) {
    case "auto": {
      const base = inferBaseType(value);
      writeBinByTypeExpr(writer, value, base, isOptional);
      break;
    }
    case "bool":
      writer.push(value ? 1 : 0);
      break;
    case "int":
      writer.pushIvarint(value as number | bigint);
      break;
    case "float":
      writer.pushF64LE(Number(value));
      break;
    case "str": {
      const bytes = textEncoder.encode(String(value ?? ""));
      writer.pushUvarint(bytes.length);
      writer.pushBytes(bytes);
      break;
    }
    case "list": {
      const itemExpr = inner.slice(1, -1).trim() || "str";
      const items = Array.isArray(value) ? value : [];
      writer.pushUvarint(items.length);
      for (const item of items) writeBinByTypeExpr(writer, item, itemExpr);
      break;
    }
    case "struct": {
      const fields = parseSchema(inner).fields;
      const obj = (value as AsunObj) ?? {};
      for (const field of fields)
        writeBinByTypeExpr(
          writer,
          obj[field.name],
          field.typeExpr,
          field.optional,
        );
      break;
    }
  }
}

export function encodeBinary(obj: AsunResult): Uint8Array {
  if (Array.isArray(obj)) {
    const fields = obj.length > 0 ? inferFields(obj[0]!) : [];
    const writer = new BinWriter(
      Math.max(64, obj.length * Math.max(fields.length, 1) * 16),
    );
    writer.pushUvarint(obj.length);
    for (const row of obj) {
      for (const field of fields)
        writeBinByTypeExpr(
          writer,
          row[field.name],
          field.typeExpr,
          field.optional,
        );
    }
    return writer.finish();
  }

  const fields = inferFields(obj);
  const writer = new BinWriter(Math.max(64, fields.length * 16));
  for (const field of fields)
    writeBinByTypeExpr(writer, obj[field.name], field.typeExpr, field.optional);
  return writer.finish();
}

class BinDecoder {
  view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  // Ensures `n` more bytes are available from the current position, throwing a
  // structured AsunError (rather than a native RangeError from the DataView)
  // on truncated or malformed input.
  private need(n: number): void {
    if (this.pos + n > this.view.byteLength) {
      throw new AsunError(
        `binary decode: unexpected EOF (need ${n} byte(s) at ${this.pos}, have ${this.view.byteLength})`,
      );
    }
  }

  private readU8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  // Reads an LEB128 unsigned varint as a BigInt.
  readUvarint(): bigint {
    let result = 0n;
    let shift = 0n;
    const limit = this.view.byteLength;
    while (true) {
      if (this.pos >= limit) {
        throw new AsunError("binary decode: unexpected EOF reading varint");
      }
      const b = this.view.getUint8(this.pos++);
      if (shift >= 64n) {
        throw new AsunError("binary decode: varint overflow");
      }
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result & 0xffffffffffffffffn;
      shift += 7n;
    }
  }

  // Reads a zigzag + LEB128 signed varint as a BigInt.
  readIvarint(): bigint {
    const v = this.readUvarint();
    return (v >> 1n) ^ -(v & 1n);
  }

  readStruct(fields: Field[]): AsunObj {
    const out: AsunObj = {};
    for (const field of fields)
      setField(out, field.name, this.readByTypeExpr(field.typeExpr, field.optional));
    return out;
  }

  readByTypeExpr(typeExpr: string, optional = false): unknown {
    const stripped = stripOptional(typeExpr);
    const inner = stripped.inner;
    const isOptional = optional || stripped.optional;
    if (isOptional) {
      const tag = this.readU8();
      if (tag === 0) return null;
    }

    switch (baseTypeFromExpr(inner)) {
      case "auto":
        return this.readByTypeExpr("str", isOptional);
      case "bool":
        return this.readU8() !== 0;
      case "int": {
        const value = this.readIvarint();
        // Preserve int64-range precision beyond the safe double range.
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : value;
      }
      case "float": {
        this.need(8);
        const value = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return value;
      }
      case "str": {
        const len = Number(this.readUvarint());
        this.need(len);
        const bytes = new Uint8Array(
          this.view.buffer,
          this.view.byteOffset + this.pos,
          len,
        );
        this.pos += len;
        return textDecoder.decode(bytes);
      }
      case "list": {
        const count = Number(this.readUvarint());
        const itemExpr = inner.slice(1, -1).trim() || "str";
        const out: unknown[] = [];
        for (let i = 0; i < count; i++) out.push(this.readByTypeExpr(itemExpr));
        return out;
      }
      case "struct":
        return this.readStruct(parseSchema(inner).fields);
    }
  }
}

export function decodeBinary(data: Uint8Array, schema: string): AsunResult {
  const { fields, isSlice } = parseSchema(schema);
  const decoder = new BinDecoder(data);

  let result: AsunResult;
  if (isSlice) {
    const count = Number(decoder.readUvarint());
    const rows: AsunObj[] = [];
    for (let i = 0; i < count; i++) rows.push(decoder.readStruct(fields));
    result = rows;
  } else {
    result = decoder.readStruct(fields);
  }

  if (decoder.pos !== data.length) {
    throw new AsunError(
      `binary decode: trailing bytes (read ${decoder.pos}, total ${data.length})`,
    );
  }
  return result;
}

export class AsunError extends Error {
  constructor(msg: string) {
    super(`ASUN: ${msg}`);
    this.name = "AsunError";
  }
}
