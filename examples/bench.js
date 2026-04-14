import { decode, decodeBinary, encodeBinary, encodeTyped } from '../dist/index.js';

function measureMs(fn, iters) {
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - start;
}

function fmtMs(ms, width = 8) {
  return `${ms.toFixed(2)}ms`.padStart(width);
}

function fmtBytes(bytes) {
  return `${bytes}B`;
}

function fmtRatio(base, other) {
  if (other <= 0) return '0x';
  const value = base / other;
  const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, '')}x`;
}

function fmtPct(part, total) {
  if (total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function box(title) {
  const width = 66;
  const text = ` Section ${title} `;
  const inner = text.padEnd(width - 2, ' ');
  console.log(`\n┌${'─'.repeat(width)}┐`);
  console.log(`│${inner}│`);
  console.log(`└${'─'.repeat(width)}┘`);
}

function printCase(label, stats) {
  console.log(`  ${label}`);
  console.log(
    `    Serialize:   JSON ${fmtMs(stats.jsonSerMs)}${`/${fmtBytes(stats.jsonSize)}`.padEnd(12)} | ` +
    `ASUN ${fmtMs(stats.asunSerMs)}(${fmtRatio(stats.jsonSerMs, stats.asunSerMs)})/` +
    `${fmtBytes(stats.asunSize)}(${fmtPct(stats.asunSize, stats.jsonSize)}) | ` +
    `BIN ${fmtMs(stats.binSerMs)}(${fmtRatio(stats.jsonSerMs, stats.binSerMs)})/` +
    `${fmtBytes(stats.binSize)}(${fmtPct(stats.binSize, stats.jsonSize)})`
  );
  console.log(
    `    Deserialize: JSON ${fmtMs(stats.jsonDeMs)} | ` +
    `ASUN ${fmtMs(stats.asunDeMs)}(${fmtRatio(stats.jsonDeMs, stats.asunDeMs)}) | ` +
    `BIN ${fmtMs(stats.binDeMs)}(${fmtRatio(stats.jsonDeMs, stats.binDeMs)})`
  );
}

function makeFlatRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `User${i}`,
    email: `u${i}@example.com`,
    score: 0.5 + i * 0.5,
    active: i % 2 === 0,
    dept: `Dept${i % 10}`,
    age: 20 + (i % 40),
    salary: 50000 + i * 100,
  }));
}

function makeAllTypesRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    enabled: i % 2 === 0,
    balance: 0.5 + i * 1.25,
    name: `User${i}`,
    note: `note-${i}`,
    score: 0.75 + i * 0.75,
    tags: [`tag-${i % 3}`, `grp-${i % 5}`],
  }));
}

function makeDeepRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    company: `Company${i}`,
    divisions: [
      {
        name: `Division${i % 5}`,
        teams: [
          {
            name: `Team${i % 7}`,
            projects: [
              {
                name: `Project${i % 11}`,
                tasks: [
                  { title: `Task${i}-A`, done: true },
                  { title: `Task${i}-B`, done: false },
                ],
              },
            ],
          },
        ],
      },
    ],
  }));
}

const FLAT_BIN_SCHEMA = '[{id@int,name@str,email@str,score@float,active@bool,dept@str,age@int,salary@int}]';
const ALL_TYPES_BIN_SCHEMA = '[{id@int,enabled@bool,balance@float,name@str,note@str,score@float,tags@[str]}]';
const DEEP_BIN_SCHEMA = '[{company@str,divisions@[{name@str,teams@[{name@str,projects@[{name@str,tasks@[{title@str,done@bool}]}]}]}]}]';
const SINGLE_BIN_SCHEMA = '{id@int,name@str,email@str,score@float,active@bool,dept@str,age@int,salary@int}';

function runCase(rows, schema, loops) {
  const jsonText = JSON.stringify(rows);
  const asunText = encodeTyped(rows);
  const binData = encodeBinary(rows);

  return {
    jsonSerMs: measureMs(() => JSON.stringify(rows), loops),
    asunSerMs: measureMs(() => encodeTyped(rows), loops),
    binSerMs: measureMs(() => encodeBinary(rows), loops),
    jsonDeMs: measureMs(() => JSON.parse(jsonText), loops),
    asunDeMs: measureMs(() => decode(asunText), loops),
    binDeMs: measureMs(() => decodeBinary(binData, schema), loops),
    jsonSize: jsonText.length,
    asunSize: asunText.length,
    binSize: binData.length,
  };
}

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║ ASUN JS Benchmark                                               ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');

box('1: Flat Struct (8 fields, vec)');
for (const n of [100, 500, 1000]) {
  const rows = makeFlatRows(n);
  const loops = n <= 500 ? 200 : 100;
  printCase(`Flat struct × ${n} (8 fields, vec)`, runCase(rows, FLAT_BIN_SCHEMA, loops));
}

box('2: All-Types Struct');
for (const n of [100, 500]) {
  const rows = makeAllTypesRows(n);
  printCase(`All-types struct × ${n} (7 fields)`, runCase(rows, ALL_TYPES_BIN_SCHEMA, 150));
}

box('3: 5-Level Deep Nesting');
for (const n of [10, 50, 100]) {
  const rows = makeDeepRows(n);
  printCase(`5-level deep × ${n} (Company hierarchy)`, runCase(rows, DEEP_BIN_SCHEMA, 40));
}

box('4: Single Struct Roundtrip');
{
  const row = makeFlatRows(1)[0];
  const jsonText = JSON.stringify(row);
  const asunText = encodeTyped(row);
  const binData = encodeBinary(row);
  const loops = 10000;
  printCase('Single flat struct × 10000 (8 fields)', {
    jsonSerMs: measureMs(() => JSON.stringify(row), loops),
    asunSerMs: measureMs(() => encodeTyped(row), loops),
    binSerMs: measureMs(() => encodeBinary(row), loops),
    jsonDeMs: measureMs(() => JSON.parse(jsonText), loops),
    asunDeMs: measureMs(() => decode(asunText), loops),
    binDeMs: measureMs(() => decodeBinary(binData, SINGLE_BIN_SCHEMA), loops),
    jsonSize: jsonText.length,
    asunSize: asunText.length,
    binSize: binData.length,
  });
}

box('5: Large Payload');
{
  const rows = makeFlatRows(10000);
  printCase('Large payload × 10000 (8 fields, vec)', runCase(rows, FLAT_BIN_SCHEMA, 10));
}

box('6: Throughput Summary');
{
  const rows = makeFlatRows(1000);
  const jsonText = JSON.stringify(rows);
  const asunText = encodeTyped(rows);
  const binData = encodeBinary(rows);
  const loops = 100;

  const jsonSerMs = measureMs(() => JSON.stringify(rows), loops);
  const asunSerMs = measureMs(() => encodeTyped(rows), loops);
  const binSerMs = measureMs(() => encodeBinary(rows), loops);
  const jsonDeMs = measureMs(() => JSON.parse(jsonText), loops);
  const asunDeMs = measureMs(() => decode(asunText), loops);
  const binDeMs = measureMs(() => decodeBinary(binData, FLAT_BIN_SCHEMA), loops);

  const jsonSerRps = Math.round((rows.length * loops) / (jsonSerMs / 1000));
  const asunSerRps = Math.round((rows.length * loops) / (asunSerMs / 1000));
  const binSerRps = Math.round((rows.length * loops) / (binSerMs / 1000));
  const jsonDeRps = Math.round((rows.length * loops) / (jsonDeMs / 1000));
  const asunDeRps = Math.round((rows.length * loops) / (asunDeMs / 1000));
  const binDeRps = Math.round((rows.length * loops) / (binDeMs / 1000));

  console.log(
    `  Serialize throughput:   JSON ${jsonSerRps.toLocaleString().padStart(12)} rec/s | ` +
    `ASUN ${asunSerRps.toLocaleString().padStart(12)} rec/s (${fmtRatio(asunSerRps, jsonSerRps)}) | ` +
    `BIN ${binSerRps.toLocaleString().padStart(12)} rec/s (${fmtRatio(binSerRps, jsonSerRps)})`
  );
  console.log(
    `  Deserialize throughput: JSON ${jsonDeRps.toLocaleString().padStart(12)} rec/s | ` +
    `ASUN ${asunDeRps.toLocaleString().padStart(12)} rec/s (${fmtRatio(asunDeRps, jsonDeRps)}) | ` +
    `BIN ${binDeRps.toLocaleString().padStart(12)} rec/s (${fmtRatio(binDeRps, jsonDeRps)})`
  );
  console.log(
    `  Size baseline (1k rows): JSON ${fmtBytes(jsonText.length)} | ` +
    `ASUN ${fmtBytes(asunText.length)}(${fmtPct(asunText.length, jsonText.length)}) | ` +
    `BIN ${fmtBytes(binData.length)}(${fmtPct(binData.length, jsonText.length)})`
  );
}
