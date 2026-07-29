import { execSync } from 'node:child_process';

// Bundle CLI with esbuild — @modelcontextprotocol/sdk exports map is already
// patched by postinstall (./dist/esm/* → ./dist/esm/*.js), so esbuild resolves
// our .js extension imports correctly.
execSync(
  'npx -y esbuild dist/cli/index.js --bundle --outfile=dist/bundle.js --platform=node --format=cjs --external:better-sqlite3 --external:node-pty',
  { stdio: 'inherit', cwd: process.cwd() }
);

// Package with pkg
execSync(
  'npx -y -p @yao-pkg/pkg pkg dist/bundle.js --output dist/orc --fallback-to-source -c package.json',
  { stdio: 'inherit', cwd: process.cwd() }
);