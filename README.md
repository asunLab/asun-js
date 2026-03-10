# ason-js

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-ason--js-blue)](https://www.npmjs.com/package/ason-js)

Zero-dependency JavaScript/TypeScript library for **ASON** (Array-Schema Object Notation) — a token-efficient, schema-driven data format for LLM interactions and large-scale data transfer.

`ason-js` is the official runtime for both JavaScript and TypeScript users. It ships ESM/CJS builds and bundled `.d.ts` type declarations in a single package, so there is no separate `ason-ts` package to install.

Works in **browsers**, **Node.js**, **Deno**, **Bun** and any JS framework: **Vue**, **React**, **Svelte**, **SolidJS**, etc.

[中文文档](README_CN.md)

---

## What is ASON?

ASON separates **schema** from **data**, eliminating repeated key names found in JSON. The schema is declared once; each data row carries only values:

```text
JSON (100 tokens):
{"users":[{"id":1,"name":"Alice","active":true},{"id":2,"name":"Bob","active":false}]}

ASON (~35 tokens, 65% saved):
[{id:int, name:str, active:bool}]:(1,Alice,true),(2,Bob,false)
```

| Aspect | JSON | ASON |
|--------|------|------|
| Token efficiency | 100% | 30–70% ✓ |
| Key repetition | Every object | Declared once ✓ |
| Human readable | Yes | Yes ✓ |
| Type annotations | None | Built-in ✓ |
| Data size | 100% | **40–55%** ✓ |

---

## Install

```bash
npm install ason-js
```

Or copy `dist/ason.min.js` directly into a web page (exposes a global `ASON` object).

---

## Quick start

```ts
import { encode, decode, encodePretty, encodeBinary, decodeBinary } from 'ason-js';

const users = [
  { id: 1, name: 'Alice', score: 9.5 },
  { id: 2, name: 'Bob',   score: 7.2 },
];
const schema = '[{id:int, name:str, score:float}]';

const text   = encode(users, schema);
const pretty = encodePretty(users, schema);
const blob   = encodeBinary(users, schema);

console.log(decode(text));               // original array restored
console.log(decode(pretty));             // same result from pretty text
console.log(decodeBinary(blob, schema)); // same result from binary
```

---

## API

```ts
// Schema string formats:
//   Single struct:  "{field:type, ...}"
//   Slice:          "[{field:type, ...}]"
//
// Types: int  uint  float  bool  str
// Optional: add '?' suffix  →  str?  int?  float?  ...
```

### `encode(obj, schema) → string`

Serialize a plain object or array of objects to ASON text:

```ts
const text = encode({ id: 1, name: 'Alice' }, '{id:int, name:str}');
// → '{id:int, name:str}:\n(1,Alice)\n'

const text2 = encode(rows, '[{id:int, name:str}]');
```

### `decode(text) → object | object[]`

Deserialize ASON text back to a plain object or array:

```ts
const rec  = decode('{id:int, name:str}:\n(1,Alice)\n');
const rows = decode('[{id:int, name:str}]:\n(1,Alice),\n(2,Bob)\n');
```

### `encodePretty(obj, schema) → string`

Serialize with smart indentation for readability:

```ts
const pretty = encodePretty(rows, '[{id:int, name:str}]');
```

### `encodeBinary(obj, schema) → Uint8Array`

Serialize to binary format (byte-compatible with ason-rs and ason-go):

```ts
const data = encodeBinary(rows, '[{id:int, name:str}]');
```

### `decodeBinary(data, schema) → object | object[]`

Deserialize from binary format:

```ts
const rows = decodeBinary(data, '[{id:int, name:str}]');
```

---

## Supported types

| Schema type | JS value | Example |
|-------------|----------|---------|
| `int` | number (integer) | `42`, `-100` |
| `uint` | number (non-negative integer) | `0`, `9007199254740991` |
| `float` | number | `3.14`, `-0.5` |
| `bool` | boolean | `true`, `false` |
| `str` | string | `Alice`, `"Carol Smith"` |
| `T?` | value or `null` | `hello` / `null` |

Optional fields: append `?` to any type (`str?`, `int?`, `float?`, `bool?`, `uint?`).

---

## Browser (CDN) usage

```html
<script src="dist/ason.min.js"></script>
<script>
  const text = ASON.encode([{id:1, name:'Alice'}], '[{id:int, name:str}]');
  console.log(ASON.decode(text));
</script>
```

## ESM in browser

```html
<script type="module">
  import { encode, decode } from './dist/index.js';
  const text = encode([{id:1, name:'Alice'}], '[{id:int, name:str}]');
  console.log(decode(text));
</script>
```

## Vue / React / Svelte / SolidJS

Works as a regular npm package — just import and use:

```ts
// Vue composable example
import { encode, decode } from 'ason-js';

export function useAson(schema: string) {
  const serialize = (data: object[]) => encode(data, schema);
  const deserialize = (text: string) => decode(text);
  return { serialize, deserialize };
}
```

---

## Binary format

Little-endian layout, byte-identical to ason-rs and ason-go:

| Type | Bytes |
|------|-------|
| `int` | 8 (i64 LE) |
| `uint` | 8 (u64 LE) |
| `float` | 8 (f64 LE) |
| `bool` | 1 |
| `str` | 4-byte length LE + UTF-8 bytes |
| optional | 1-byte tag (0=null, 1=present) + value |
| slice | 4-byte count LE + elements |

---

## Build from source

```bash
npm install
npm run build    # generates dist/index.js, dist/index.cjs, dist/ason.min.js
npm test         # vitest, 40 tests
```

---

## Run examples

```bash
node examples/basic.js     # 9 scenarios, basic usage
node examples/complex.js   # 20 scenarios, edge cases
node examples/bench.js     # performance vs JSON.parse / JSON.stringify
```

---

## Performance

ASON JS produces **50–55% smaller** output than JSON. Because `JSON.parse` / `JSON.stringify` are implemented in C, raw speed is slower — but:

- **Network bandwidth** is typically the bottleneck — 50% smaller payload saves more time than parse overhead costs
- **LLM token cost** — 30–70% fewer tokens = lower API cost and faster responses
- **Binary format** — `encodeBinary` / `decodeBinary` is fastest for machine-to-machine transfer

For latency-sensitive hot paths, use the [Rust](../ason-rs/) or [Go](../ason-go/) implementations if your stack supports them.

---

## License

MIT

## Contributors

- [Athan](https://github.com/athxx)

## Latest Benchmarks

Measured on this machine with Node `24.14.0`.

Headline numbers:

- Flat 1,000-record dataset: ASON text `58,539 B` vs JSON `121,451 B` (`51.8%` smaller)
- Flat 5,000-record dataset: ASON serialize `8.93ms` vs JSON `13.27ms`, but deserialize `20.10ms` vs JSON `16.92ms`
- Large 10,000-record dataset: ASON serialize `37.86ms` vs JSON `20.23ms`, deserialize `37.25ms` vs JSON `33.82ms`
- Throughput summary on 10,000-record-style text path: ASON text serialize ran at `0.30 M records/s` vs JSON `0.75 M`-class baseline, and deserialize was roughly at parity in this run
- Binary path is mainly useful for decode and transport size here: on 1,000 records, BIN deserialize `4.68ms` vs JSON `2.08ms`, with payload `72,784 B` vs JSON `121,451 B`
