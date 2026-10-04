// Basic packaging and Pi-loader smoke check, including packages without unit tests.
const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function check(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!manifest.pi?.extensions?.length) return;
  const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8',
      shell: process.platform === 'win32' }));
  const files = new Set(packed[0].files.map(file => file.path));
  const entries = manifest.pi.extensions.map(entry => resolve(root, entry));
  for (const entry of manifest.pi.extensions) {
    if (!files.has(entry.replace(/^\.\//, ''))) throw new Error(`Missing packed Pi entry: ${entry}`);
  }
  const requireFromPackage = createRequire(join(root, 'package.json'));
  const loaderPath = requireFromPackage.resolve.paths('@earendil-works/pi-coding-agent')
    .map(path => join(path, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).find(existsSync);
  if (!loaderPath) throw new Error('Pi runtime must be installed for CI smoke checks');
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions(entries, root);
  if (loaded.errors.length || loaded.extensions.length !== entries.length) {
    throw new Error(`Pi loader failed: ${JSON.stringify(loaded.errors)}`);
  }
  console.log(`Package and Pi loader passed: ${manifest.name}`);
}

(async () => {
  const root = process.cwd();
  if (existsSync(join(root, 'package.json'))) {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.workspaces?.includes('packages/*')) {
      const { readdirSync } = require('node:fs');
      for (const dir of readdirSync(join(root, 'packages'))) await check(join(root, 'packages', dir));
    } else await check(root);
  } else await check(join(root, 'plan-build-mode'));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
