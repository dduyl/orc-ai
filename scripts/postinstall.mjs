import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// @modelcontextprotocol/sdk v1.29.0 has exports map "/*" → "./dist/esm/*"
// which fails to resolve extensionless file subpaths (e.g. "types" not "types.js").
// This is a known issue with the SDK packaging — the fix adds .js extension to the
// glob targets so both Node.js runtime and esbuild can resolve them.
const sdkPkgPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/package.json');

try {
  const orig = readFileSync(sdkPkgPath, 'utf8');
  const patched = orig
    .replace(/"import":\s*"\.\/dist\/esm\/\*"/, '"import": "./dist/esm/*.js"')
    .replace(/"require":\s*"\.\/dist\/cjs\/\*"/, '"require": "./dist/cjs/*.js"');
  
  if (orig !== patched) {
    writeFileSync(sdkPkgPath, patched);
    console.log('[postinstall] Patched @modelcontextprotocol/sdk exports map (.js extension added to glob targets)');
  }
} catch {
  // SDK might not be installed yet (e.g. during npm install dependency resolution)
}