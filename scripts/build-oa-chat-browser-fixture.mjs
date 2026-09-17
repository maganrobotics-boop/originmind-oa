// Compile the actual OA page for an isolated browser acceptance test.
// API calls must be intercepted by the test; no production data or credentials.
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(root, '.wrangler/oa-chat-browser-fixture');
const output = path.join(root, 'parity-validation/browser-app');
await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OA isolated browser acceptance</title></head><body><div id="root"></div><script type="module" src="./entry.mjs"></script></body></html>');
await writeFile(path.join(fixture, 'entry.mjs'), "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport '../../app/globals.css';\nimport Home from '../../app/page.tsx';\ncreateRoot(document.getElementById('root')).render(React.createElement(Home));\n");
await build({
  configFile: false,
  root,
  plugins: [react()],
  resolve: { alias: { '@': root } },
  publicDir: path.join(root, 'public'),
  build: { outDir: output, emptyOutDir: true, sourcemap: false, rollupOptions: { input: path.join(fixture, 'index.html') } },
});
async function htmlFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await htmlFiles(file));
    else if (entry.name.endsWith('.html')) found.push(file);
  }
  return found;
}
const files = await htmlFiles(output);
const built = files.find(file => file.endsWith('/oa-chat-browser-fixture/index.html')) || files.find(file => file === path.join(output, 'index.html'));
if (!built) throw new Error('Browser fixture HTML was not emitted');
await writeFile(path.join(output, 'index.html'), await readFile(built));
console.log('Actual OA page browser fixture built without API access or production credentials.');
