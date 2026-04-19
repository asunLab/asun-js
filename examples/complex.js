import {
  AsunError,
  decode,
  decodeBinary,
  encode,
  encodeBinary,
  encodePrettyTyped,
  encodeTyped,
} from '../dist/index.js';

let passed = 0;
let failed = 0;

function ok(label, condition, extra = '') {
  if (condition) {
    console.log(`  [OK]   ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${extra ? ': ' + extra : ''}`);
    failed++;
  }
}

function eq(label, got, expected) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(expected);
  ok(label, a === b, a === b ? '' : `got=${a} expected=${b}`);
}

function throws(label, fn) {
  try {
    fn();
    ok(label, false, 'expected error');
  } catch {
    ok(label, true);
  }
}

console.log('\n=== asun-js complex examples ===\n');

console.log('1. Flat struct');
eq('flat roundtrip', decode(encodeTyped({ id: 1, name: 'Alice', active: true })), {
  id: 1,
  name: 'Alice',
  active: true,
});

console.log('2. Nested object');
{
  const payload = {
    service: 'api',
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  };
  eq('nested roundtrip', decode(encodeTyped(payload)), payload);
}

console.log('3. Array of nested objects');
{
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
  eq('nested slice roundtrip', decode(encodeTyped(rows)), rows);
}

console.log('4. Untyped nested decode');
{
  const text = encode({
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  });
  eq('untyped nested decode', decode(text), {
    profile: { host: '127.0.0.1', port: '8080' },
    tags: ['blue', 'fast'],
  });
}

console.log('5. Pretty typed nested output');
{
  const payload = {
    service: 'api',
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  };
  const pretty = encodePrettyTyped(payload);
  ok('pretty has newline', pretty.includes('\n'));
  eq('pretty roundtrip', decode(pretty), payload);
}

console.log('6. Strings and escapes');
{
  const row = { note: 'Smith, John [admin]\nline2\tok' };
  eq('escaped string roundtrip', decode(encodeTyped(row)), row);
}

console.log('7. Empty slots');
eq('null slot', decode('{id@int,tag@str,score@float}:\n(1,,3.5)\n'), {
  id: 1,
  tag: null,
  score: 3.5,
});

console.log('8. Comments');
eq('commented slice', decode('/* users */\n[{id@int,name@str}]:\n(1,Alice),\n(2,Bob)\n'), [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
]);

console.log('9. Binary nested single');
{
  const obj = {
    name: 'api',
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  };
  const schema = '{name@str,profile@{host@str,port@int},tags@[str]}';
  eq('binary nested single', decodeBinary(encodeBinary(obj), schema), obj);
}

console.log('10. Binary nested slice');
{
  const rows = [
    {
      id: 1,
      profile: { host: '127.0.0.1', port: 8080 },
      members: [{ name: 'Alice', role: 'owner' }],
    },
    {
      id: 2,
      profile: { host: '10.0.0.2', port: 9000 },
      members: [{ name: 'Bob', role: 'viewer' }],
    },
  ];
  const schema = '[{id@int,profile@{host@str,port@int},members@[{name@str,role@str}]}]';
  eq('binary nested slice', decodeBinary(encodeBinary(rows), schema), rows);
}

console.log('11. Invalid schema rejection');
throws('reject invalid schema type', () => decode('{attrs@dict}:\n(value)\n'));
throws('reject invalid binary schema type', () => decodeBinary(new Uint8Array(0), '{attrs@dict}'));

console.log('12. Large flat slice');
{
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    name: `User${i}`,
    email: `u${i}@example.com`,
    score: 0.5 + i * 0.5,
    active: i % 2 === 0,
  }));
  const typed = encodeTyped(rows);
  const untyped = encode(rows);
  const json = JSON.stringify(rows);
  const typedPct = ((typed.length / json.length) * 100).toFixed(1);
  const untypedPct = ((untyped.length / json.length) * 100).toFixed(1);
  console.log(`   ASUN typed:   ${typed.length} B (${typedPct}%)`);
  console.log(`   ASUN untyped: ${untyped.length} B (${untypedPct}%)`);
  console.log(`   JSON:         ${json.length} B`);
  eq('1000-row last item', decode(typed)[999], rows[999]);
}

console.log('13. Deep nesting');
{
  const payload = {
    company: 'Acme',
    divisions: [
      {
        name: 'Platform',
        teams: [
          {
            name: 'Core',
            projects: [
              {
                name: 'Deploy',
                tasks: [
                  { title: 'ship', done: true },
                  { title: 'verify', done: false },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  eq('deep roundtrip', decode(encodeTyped(payload)), payload);
}

console.log('14. Binary trailing bytes');
{
  const data = encodeBinary({ x: 1 });
  const padded = new Uint8Array(data.length + 1);
  padded.set(data);
  padded[data.length] = 0xff;
  throws('binary trailing bytes rejected', () => decodeBinary(padded, '{x@int}'));
}

console.log('15. Error type');
{
  try {
    decode('{attrs@dict}:\n(value)\n');
    ok('AsunError shape', false);
  } catch (err) {
    ok('AsunError shape', err instanceof AsunError);
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
