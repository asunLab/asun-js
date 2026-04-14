import {
  decode,
  decodeBinary,
  encode,
  encodeBinary,
  encodePrettyTyped,
  encodeTyped,
} from '../dist/index.js';

let passed = 0;

function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? 'OK' : 'FAIL'}] ${label}`);
  if (!ok) {
    console.log('    got:     ', got);
    console.log('    expected:', expected);
  }
  if (ok) passed++;
}

console.log('\n=== asun-js basic examples ===\n');

console.log('1. Flat struct (typed)');
{
  const user = { id: 1, name: 'Alice', active: true };
  const text = encodeTyped(user);
  console.log('   encoded:', JSON.stringify(text));
  check('typed roundtrip', decode(text), user);
}

console.log('2. Nested struct + array');
{
  const service = {
    name: 'api',
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  };
  const text = encodeTyped(service);
  console.log('   encoded:\n' + text);
  check('nested roundtrip', decode(text), service);
}

console.log('3. Untyped encode keeps structural markers');
{
  const text = encode({
    name: 'api',
    profile: { host: '127.0.0.1', port: 8080 },
    tags: ['blue', 'fast'],
  });
  console.log('   untyped:\n' + text);
  check('header contains profile scaffold', text.startsWith('{name,profile@{host,port},tags@[]}:'), true);
}

console.log('4. Slice of structs');
{
  const rows = [
    { id: 1, name: 'Alice', score: 9.5 },
    { id: 2, name: 'Bob', score: 7.25 },
  ];
  check('slice roundtrip', decode(encodeTyped(rows)), rows);
}

console.log('5. String escaping');
{
  const row = { note: 'Smith, John [admin]\nline2' };
  check('escaped string roundtrip', decode(encodeTyped(row)), row);
}

console.log('6. Empty slot becomes null');
{
  const text = '{id@int,tag@str,score@float}:\n(1,,3.5)\n';
  check('null slot', decode(text), { id: 1, tag: null, score: 3.5 });
}

console.log('7. Pretty typed output');
{
  const rows = [
    { id: 1, name: 'Alice', profile: { host: '127.0.0.1', port: 8080 } },
    { id: 2, name: 'Bob', profile: { host: '10.0.0.2', port: 9000 } },
  ];
  const pretty = encodePrettyTyped(rows);
  console.log('   pretty:\n' + pretty);
  check('pretty roundtrip', decode(pretty), rows);
}

console.log('8. Binary encode/decode');
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
  const data = encodeBinary(rows);
  console.log(`   binary size: ${data.length} bytes`);
  check('binary roundtrip', decodeBinary(data, schema), rows);
}

console.log(`\nResult: ${passed} passed`);
