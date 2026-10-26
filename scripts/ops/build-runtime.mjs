// Build-only tool: TS/source aliases never require tsx in the production worker.
// esbuild is supplied by the locked tsx build dependency, not fetched at runtime.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const buildRequire = createRequire(require.resolve('tsx/package.json'));
const { build } = buildRequire('esbuild');
const outdir = resolve(process.argv[2] ?? 'dist/ops');
const result = await build({
  entryPoints: {
    'storage-cleanup-worker': 'scripts/ops/storage-cleanup-worker.ts',
    'async-worker': 'scripts/ops/async-worker.ts',
    'ops-check': 'scripts/ops/ops-check.ts',
  },
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
  metafile: true,
});
// Use the bundle's actual external imports as the dependency authority. Retain
// the repository lock entries/integrities; npm ci, not ad-hoc folder deletion,
// constructs their production graph. New unlisted external imports fail build.
const original = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const dependencies = {};
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || dependency.path.startsWith('node:')) continue;
    const parts = dependency.path.split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!original.dependencies[name]) throw new Error(`Worker runtime import is not a declared production dependency: ${name}`);
    dependencies[name] = original.dependencies[name];
  }
}
const manifest = { name: original.name, version: original.version, private: true, dependencies, overrides: original.overrides ?? {} };
lock.packages[''] = { name: original.name, version: original.version, dependencies };
writeFileSync(resolve(outdir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(outdir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
