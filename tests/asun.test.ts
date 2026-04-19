import { describe, expect, it } from 'vitest';
import {
  AsunError,
  decode,
  decodeBinary,
  encode,
  encodeBinary,
  encodePretty,
  encodePrettyTyped,
  encodeTyped,
} from '../src/index.js';

describe('header generation', () => {
  it('encodes scalar fields with @ in typed mode', () => {
    const text = encodeTyped({ id: 1, name: 'Alice', active: true });
    expect(text).toMatch(/^\{id@int,name@str,active@bool\}:/);
  });

  it('encodes scalar fields without types in untyped mode', () => {
    const text = encode({ id: 1, name: 'Alice', active: true });
    expect(text).toMatch(/^\{id,name,active\}:/);
  });

  it('keeps structural markers for nested object and array fields', () => {
    const text = encode({
      name: 'svc',
      profile: { host: '127.0.0.1', port: 8080 },
      tags: ['api', 'prod'],
      members: [{ id: 1, role: 'owner' }],
    });
    expect(text).toMatch(/^\{name,profile@\{host,port\},tags@\[\],members@\[\{id,role\}\]\}:/);
  });

  it('quotes schema field names with spaces, numeric strings, and specials', () => {
    const text = encodeTyped({ 'id uuid': 1, '65': 'Alice', '{}[]@"': true });
    expect(text).toBe('{"65"@str,"id uuid"@int,"{}[]@\\\""@bool}:\n(Alice,1,true)\n');
    expect(decode(text)).toEqual({ 'id uuid': 1, '65': 'Alice', '{}[]@"': true });
  });
});

describe('text roundtrip', () => {
  it('roundtrips a flat struct in typed mode', () => {
    const row = { id: 1, name: 'Alice', active: true };
    expect(decode(encodeTyped(row))).toEqual(row);
  });

  it('roundtrips nested structs and arrays', () => {
    const payload = {
      service: 'api',
      profile: { host: '127.0.0.1', port: 8080 },
      tags: ['blue', 'fast'],
      members: [
        { id: 1, role: 'owner' },
        { id: 2, role: 'viewer' },
      ],
    };
    expect(decode(encodeTyped(payload))).toEqual(payload);
  });

  it('roundtrips slices of structs', () => {
    const rows = [
      { id: 1, name: 'Alice', score: 9.5 },
      { id: 2, name: 'Bob', score: 7.25 },
    ];
    expect(decode(encodeTyped(rows))).toEqual(rows);
  });

  it('roundtrips untyped nested data with auto-detected scalars', () => {
    const text = encode({
      profile: { host: '127.0.0.1', port: 8080 },
      tags: ['blue', 'fast'],
    });
    expect(decode(text)).toEqual({
      profile: { host: '127.0.0.1', port: 8080 },
      tags: ['blue', 'fast'],
    });
  });

  it('parses explicit empty slot as null', () => {
    const text = '{id@int,tag@str,score@float}:\n(1,,3.5)\n';
    expect(decode(text)).toEqual({ id: 1, tag: null, score: 3.5 });
  });

  it('supports comments and multiline slices', () => {
    const text = '/* users */\n[{id@int,name@str}]:\n  (1,Alice),\n  (2,Bob)\n';
    expect(decode(text)).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('pretty typed text still roundtrips', () => {
    const rows = [
      { id: 1, name: 'Alice', profile: { host: '127.0.0.1', port: 8080 } },
      { id: 2, name: 'Bob', profile: { host: '10.0.0.2', port: 9000 } },
    ];
    expect(decode(encodePrettyTyped(rows))).toEqual(rows);
  });
});

describe('string handling', () => {
  it('quotes strings with commas and brackets', () => {
    const obj = { note: 'Smith, John [admin]' };
    expect(decode(encodeTyped(obj))).toEqual(obj);
  });

  it('quotes empty strings and bool-like strings', () => {
    expect(decode(encodeTyped({ a: '', b: 'true' }))).toEqual({ a: '', b: 'true' });
  });

  it('handles escaped control characters', () => {
    const obj = { message: 'line1\nline2\tok' };
    expect(decode(encodeTyped(obj))).toEqual(obj);
  });

  it('quotes string values containing @ across APIs', () => {
    const obj = { message: '@Alice' };
    expect(encode(obj)).toContain('"@Alice"');
    expect(decode(encode(obj))).toEqual(obj);
    expect(decode(encodeTyped(obj))).toEqual(obj);
    expect(decode(encodePretty(obj))).toEqual(obj);
    expect(decode(encodePrettyTyped(obj))).toEqual(obj);
    expect(decodeBinary(encodeBinary(obj), '{message@str}')).toEqual(obj);
  });

  it('rejects invalid schema types', () => {
    expect(() => decode('{id@numx,name@str}:(1,Alice)')).toThrow(AsunError);
    expect(() => decode('{id@int,name@textx}:(1,Alice)')).toThrow(AsunError);
    expect(() => decode('{score@decimalx}:(3.5)')).toThrow(AsunError);
    expect(() => decode('{active@flagx}:(true)')).toThrow(AsunError);
    expect(() => decode('{tags@[textx]}:([Alice])')).toThrow(AsunError);
    expect(() => decode('{id@uint}:(1)')).toThrow(AsunError);
  });
});

describe('binary roundtrip', () => {
  it('roundtrips a single nested struct', () => {
    const obj = {
      name: 'api',
      profile: { host: '127.0.0.1', port: 8080 },
      tags: ['blue', 'fast'],
    };
    const schema = '{name@str,profile@{host@str,port@int},tags@[str]}';
    expect(decodeBinary(encodeBinary(obj), schema)).toEqual(obj);
  });

  it('roundtrips slices with nested object arrays', () => {
    const rows = [
      {
        id: 1,
        members: [
          { name: 'Alice', role: 'owner' },
          { name: 'Bob', role: 'viewer' },
        ],
      },
      {
        id: 2,
        members: [{ name: 'Carol', role: 'owner' }],
      },
    ];
    const schema = '[{id@int,members@[{name@str,role@str}]}]';
    expect(decodeBinary(encodeBinary(rows), schema)).toEqual(rows);
  });

  it('rejects trailing binary bytes', () => {
    const data = encodeBinary({ x: 1 });
    const padded = new Uint8Array(data.length + 1);
    padded.set(data);
    padded[data.length] = 0xff;
    expect(() => decodeBinary(padded, '{x@int}')).toThrow(AsunError);
  });

  it('roundtrips binary with quoted schema field names', () => {
    const row = { 'id uuid': 1, '65': 'Alice', '{}[]@"': true };
    const schema = '{"65"@str,"id uuid"@int,"{}[]@\\\""@bool}';
    expect(decodeBinary(encodeBinary(row), schema)).toEqual(row);
  });
});

describe('unsupported syntax rejection', () => {
  it('rejects multiple tuples after a single-row schema', () => {
    expect(() => decode('{id@int,name@str}:(101,Alice),(102,Bob)')).toThrow(AsunError);
  });

  it('rejects invalid schema types in text decode', () => {
    expect(() => decode('{attrs@dict}:\n(value)\n')).toThrow(AsunError);
  });

  it('rejects invalid schema types in binary decode', () => {
    expect(() => decodeBinary(new Uint8Array(0), '{attrs@dict}')).toThrow(AsunError);
  });
});

describe('scale sanity', () => {
  it('roundtrips a 1000-row typed slice', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `User${i}`,
      active: i % 2 === 0,
      score: 0.5 + i * 0.5,
    }));
    const decoded = decode(encodeTyped(rows)) as typeof rows;
    expect(decoded).toHaveLength(1000);
    expect(decoded[999]).toEqual(rows[999]);
  });
});

describe('quoted schema field names', () => {
  it('roundtrips across encode variants', () => {
    const row = { 'id uuid': 1, '65': 'Alice', '{}[]@"': true };
    expect(decode(encode(row))).toEqual(row);
    expect(decode(encodePretty(row))).toEqual(row);
    expect(decode(encodeTyped(row))).toEqual(row);
    expect(decode(encodePrettyTyped(row))).toEqual(row);
  });

  it('decodes explicit quoted schema names', () => {
    const text = '{"id uuid"@int,"65"@str,"{}[]@\\\""@bool}:\n(1,Alice,true)\n';
    expect(decode(text)).toEqual({ 'id uuid': 1, '65': 'Alice', '{}[]@"': true });
  });
});
