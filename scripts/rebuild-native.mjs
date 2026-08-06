import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Phase D D-5: host-only rebuild.
//
// `node-pty` is host-only and daemon-only. The GUI (Electron) is a pure pipe
// client with zero native addons, so it never needs an Electron-ABI build.
// The only consumer of `node-pty` is the daemon block, which runs under host
// Node (dev: spawned via `node`; packaged: the bundled `orc` binary), so the
// sole rebuild target is the host ABI.

console.log(`[rebuild-native] Host Node.js: v${process.versions.node}`);

const addons = [
  {
    name: 'node-pty',
    dir: 'node_modules/node-pty',
    env: { CL: '/Qspectre-' },
  },
];

for (const addon of addons) {
  const dir = join(process.cwd(), addon.dir);
  console.log(`[rebuild-native] Rebuilding ${addon.name} for host ABI...`);
  try {
    execSync('npx node-gyp rebuild --arch=x64 --msvs_version=2022', {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, ...addon.env },
    });
    console.log(`[rebuild-native] ✅ ${addon.name} rebuilt (host ABI)`);
  } catch (err) {
    console.error(`[rebuild-native] ❌ ${addon.name} rebuild failed`);
    process.exit(1);
  }
  console.log('');
}

console.log('[rebuild-native] All native addons rebuilt for host ABI');