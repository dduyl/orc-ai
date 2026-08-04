import { execSync } from 'node:child_process';

const isHost = process.argv.includes('--host');
let targetFlags = '';

if (isHost) {
  const nodeVer = process.versions.node;
  console.log(`[rebuild-native] Host Node.js: v${nodeVer}`);
} else {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const electronVer = (pkg.devDependencies?.electron || pkg.dependencies?.electron || '').replace(/^\^|~/, '');
  if (!electronVer) {
    console.error('[rebuild-native] Electron version not found in package.json');
    process.exit(1);
  }
  targetFlags = `--target=${electronVer} --dist-url=https://electronjs.org/headers`;
  console.log(`[rebuild-native] Electron target: v${electronVer}`);
}

console.log('');

const addons = [
  {
    name: 'node-pty',
    dir: 'node_modules/node-pty',
    env: { CL: '/Qspectre-' },
  },
];

for (const addon of addons) {
  const { join } = await import('node:path');
  const dir = join(process.cwd(), addon.dir);
  console.log(`[rebuild-native] Rebuilding ${addon.name}...`);
  try {
    execSync(
      `npx node-gyp rebuild --arch=x64 --msvs_version=2022 ${targetFlags}`.trim(),
      { cwd: dir, stdio: 'inherit', env: { ...process.env, ...addon.env } }
    );
    console.log(`[rebuild-native] ✅ ${addon.name} rebuilt successfully`);
  } catch (err) {
    console.error(`[rebuild-native] ❌ ${addon.name} rebuild failed`);
    process.exit(1);
  }
  console.log('');
}

const label = isHost ? 'host Node.js' : 'Electron';
console.log(`[rebuild-native] All native addons rebuilt for ${label}`);
