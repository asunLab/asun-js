// build.mjs — esbuild bundler for ason-js
import * as esbuild from 'esbuild';

// ESM bundle
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile: 'dist/index.js',
  minify: false,
});

// CJS bundle
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  minify: false,
});

// Minified UMD-style IIFE for CDN usage
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'ASON',
  outfile: 'dist/ason.min.js',
  minify: true,
});

console.log('Build complete: dist/index.js  dist/index.cjs  dist/index.d.ts  dist/ason.min.js');
