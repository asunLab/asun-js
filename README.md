# @athanx/asun

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-%40athanx%2Fasun-blue)](https://www.npmjs.com/package/@athanx/asun)

## Why ASUN?

**json**

Standard JSON repeats every field name in every record. When you send structured data to an LLM, over an API, or across services, that repetition wastes tokens, bytes, and attention:

```json
[
  { "id": 1, "name": "Alice", "active": true },
  { "id": 2, "name": "Bob", "active": false },
  { "id": 3, "name": "Carol", "active": true }
]
```

**asun**

ASUN declares the schema **once** and streams data as compact tuples:

```asun
[{id, name, active}]:
  (1,Alice,true),
  (2,Bob,false),
  (3,Carol,true)
```

**Fewer tokens. Smaller payloads. Clearer structure, and faster parsing than repeated-object JSON.**

---

Zero-dependency JavaScript/TypeScript library for **ASUN** (Array-Schema Unified Notation) — a token-efficient, schema-driven data format for LLM interactions and large-scale data transfer.

`@athanx/asun` is the official runtime for both JavaScript and TypeScript users. It ships ESM/CJS builds and bundled `.d.ts` type declarations in a single package, so there is no separate `asun-ts` package to install.

Works in **browsers**, **Node.js**, **Deno**, **Bun** and any JS framework: **Vue**, **React**, **Svelte**, **SolidJS**, etc.

[中文文档](README_CN.md)

---

## What is ASUN?

ASUN separates **schema** from **data**, eliminating repeated key names found in JSON. The schema is declared once; each data row carries only values:

```text
JSON (100 tokens):
{"users":[{"id":1,"name":"Alice","active":true},{"id":2,"name":"Bob","active":false}]}

ASUN (~35 tokens, 65% saved):
[{id@int, name@str, active@bool}]:(1,Alice,true),(2,Bob,false)
```

| Aspect           | JSON         | ASUN            |
| ---------------- | ------------ | --------------- |
| Token efficiency | 100%         | 30–70% ✓        |
| Key repetition   | Every object | Declared once ✓ |
| Human readable   | Yes          | Yes ✓           |
| Type annotations | None         | Built-in ✓      |
| Data size        | 100%         | **40–55%** ✓    |

---

## Install

```bash
npm install @athanx/asun
```

Or copy `dist/asun.min.js` directly into a web page (exposes a global `ASUN` object).

TypeScript users do not need a separate stub package. `npm run build` emits `dist/index.d.ts`, and the package exports it via the `types` field.

---

## Quick start

```ts
import {
  encode,
  encodeTyped,
  encodePretty,
  encodePrettyTyped,
  decode,
  encodeBinary,
  decodeBinary,
} from "@athanx/asun";

const users = [
  { id: 1, name: "Alice", score: 9.5 },
  { id: 2, name: "Bob", score: 7.2 },
];

// Schema is inferred automatically — no schema string needed
const text = encode(users); // schema without scalar hints
const textTyped = encodeTyped(users); // schema with scalar hints (use for typed round-trip)
const pretty = encodePretty(users); // pretty + untyped
const prettyTyped = encodePrettyTyped(users); // pretty + scalar hints
const blob = encodeBinary(users); // binary (schema inferred internally)

console.log(decode(textTyped)); // original array restored
console.log(decode(prettyTyped)); // same from pretty
console.log(decodeBinary(blob, "[{id@int, name@str, score@float}]")); // binary decode
```

> **Note on `encode` vs `encodeTyped`**
> `encode(obj)` emits a schema without scalar hints (`{id,name}`) so the output is shorter.
> When decoded, all values without explicit types are returned as strings.
> Use `encodeTyped(obj)` when you need scalar hints to preserve numeric and boolean types on round-trip.

---

## API

### Type inference rules

| JS value             | Inferred ASUN type |
| -------------------- | ------------------ |
| whole `number`       | `int`              |
| fractional `number`  | `float`            |
| `true` / `false`     | `bool`             |
| text                 | `str`              |
| `null` / `undefined` | `str?` (optional)  |

> **Note:** Schema is inferred from the **first element** of an array. To make a field optional (`str?`), ensure the first element has `null` for that field.

### `encode(obj) → string`

Serialize a plain object or array to ASUN text with an **inferred schema without scalar hints**.
When decoded, all scalar fields without explicit hints come back as **strings**:

```ts
encode({ id: 1, name: "Alice" });
// → '{id,name}:\n(1,Alice)\n'

encode([{ id: 1 }, { id: 2 }]);
// → '[{id}]:\n(1),\n(2)\n'

decode(encode({ id: 1, name: "Alice" }));
// → { id: '1', name: 'Alice' }  ← all strings when scalar hints are omitted
```

Use `encodeTyped` when you need `decode` to restore the original types.

### `encodeTyped(obj) → string`

Same as `encode` but emits an **inferred schema with scalar hints**. Use this when you want `decode()` to restore the original scalar types:

```ts
encodeTyped({ id: 1, name: "Alice", active: true });
// → '{id@int,name@str,active@bool}:\n(1,Alice,true)\n'
```

Nested object and array fields keep structural bindings even when scalar hints are omitted:

```ts
encode({
  profile: { host: "127.0.0.1", port: 8080 },
  tags: ["blue", "fast"],
});
// → '{profile@{host,port},tags@[]}:\n((127.0.0.1,8080),[blue, fast])\n'
```

### `encodePretty(obj) → string`

Pretty-printed ASUN text with **inferred untyped** schema.

### `encodePrettyTyped(obj) → string`

Pretty-printed ASUN text with **inferred typed** schema.

### `decode(text) → object | object[]`

Deserialize ASUN text. The schema is embedded in the text itself:

```ts
const rec = decode("{id@int, name@str}:\n(1,Alice)\n");
const rows = decode("[{id@int, name@str}]:\n(1,Alice),\n(2,Bob)\n");
```

### `encodeBinary(obj) → Uint8Array`

Serialize to binary format. **Schema is inferred internally** — no schema string needed:

```ts
const data = encodeBinary(rows);
```

### `decodeBinary(data, schema) → object | object[]`

Deserialize from binary format. **Schema is required** because the binary wire format carries no embedded type information:

```ts
const rows = decodeBinary(data, "[{id@int, name@str}]");
```

---

## Supported types

| Schema type | JS value         | Example                  |
| ----------- | ---------------- | ------------------------ |
| `int`       | number (integer) | `42`, `-100`             |
| `float`     | number           | `3.14`, `-0.5`           |
| `bool`      | `true` / `false` | `true`, `false`          |
| `str`       | text             | `Alice`, `"Carol Smith"` |
| `T?`        | value or `null`  | `hello` / `null`         |

Optional fields: append `?` to any type (`str?`, `int?`, `float?`, `bool?`).

---

## Browser (CDN) usage

```html
<script src="dist/asun.min.js"></script>
<script>
  const text = ASUN.encodeTyped([{ id: 1, name: "Alice" }]);
  console.log(ASUN.decode(text));
</script>
```

## ESM in browser

```html
<script type="module">
  import { encodeTyped, decode } from "./dist/index.js";
  const text = encodeTyped([{ id: 1, name: "Alice" }]);
  console.log(decode(text));
</script>
```

## Vue / React / Svelte / SolidJS

Works as a regular npm package — just import and use:

```ts
// Vue composable example
import { encodeTyped, decode } from "@athanx/asun";

export function useAsun() {
  const serialize = (data: object[]) => encodeTyped(data);
  const deserialize = (text: string) => decode(text);
  return { serialize, deserialize };
}
```

---

## Binary format

Little-endian layout, byte-identical to asun-rs and asun-go:

| Type     | Bytes                                  |
| -------- | -------------------------------------- |
| `int`    | 8 (i64 LE)                             |
| `float`  | 8 (f64 LE)                             |
| `bool`   | 1                                      |
| `str`    | 4-byte length LE + UTF-8 bytes         |
| optional | 1-byte tag (0=null, 1=present) + value |
| slice    | 4-byte count LE + elements             |

---

## Build from source

```bash
npm install
npm run build    # generates dist/index.js, dist/index.cjs, dist/index.d.ts, dist/asun.min.js
npm test         # vitest
```

---

## Run examples

```bash
node examples/basic.js     # 9 scenarios, basic usage
node examples/complex.js   # complex nested scenarios and legacy-syntax rejection
node examples/bench.js     # performance vs JSON.parse / JSON.stringify
```

---

## Performance

ASUN JS produces **50–55% smaller** output than JSON. Because `JSON.parse` / `JSON.stringify` are implemented in C, raw speed is slower — but:

- **Network bandwidth** is typically the bottleneck — 50% smaller payload saves more time than parse overhead costs
- **LLM token cost** — 30–70% fewer tokens = lower API cost and faster responses
- **Binary format** — `encodeBinary` / `decodeBinary` is fastest for machine-to-machine transfer

For latency-sensitive hot paths, use the [Rust](../asun-rs/) or [Go](../asun-go/) implementations if your stack supports them.

---

## License

MIT

## Contributors

- [Athan](https://github.com/athxx)

## Latest Benchmarks

Measured on this machine with Node `24.14.0`.

Headline numbers:

- Flat 1,000-record dataset: ASUN text `58,539 B` vs JSON `121,451 B` (`51.8%` smaller)
- Flat 5,000-record dataset: ASUN serialize `8.93ms` vs JSON `13.27ms`, but deserialize `20.10ms` vs JSON `16.92ms`
- Large 10,000-record dataset: ASUN serialize `37.86ms` vs JSON `20.23ms`, deserialize `37.25ms` vs JSON `33.82ms`
- Throughput summary on 10,000-record-style text path: ASUN text serialize ran at `0.30 M records/s` vs JSON `0.75 M`-class baseline, and deserialize was roughly at parity in this run
- Binary path is mainly useful for decode and transport size here: on 1,000 records, BIN deserialize `4.68ms` vs JSON `2.08ms`, with payload `72,784 B` vs JSON `121,451 B`
