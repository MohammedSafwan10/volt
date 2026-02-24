import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function log(msg) {
  console.log(`[sidecars:rg] ${msg}`);
}

function fail(msg) {
  console.error(`[sidecars:rg] ERROR: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[sidecars:rg] WARN: ${msg}`);
}

function isStrictMode() {
  return process.argv.includes('--strict') || process.env.VOLT_REQUIRE_RG_SIDECAR === '1';
}

function platformSpec() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'x64') return { outName: 'rg-x86_64-pc-windows-msvc.exe', lookup: 'rg.exe' };
    if (arch === 'arm64') return { outName: 'rg-aarch64-pc-windows-msvc.exe', lookup: 'rg.exe' };
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return { outName: 'rg-x86_64-apple-darwin', lookup: 'rg' };
    if (arch === 'arm64') return { outName: 'rg-aarch64-apple-darwin', lookup: 'rg' };
  }
  if (platform === 'linux') {
    if (arch === 'x64') return { outName: 'rg-x86_64-unknown-linux-gnu', lookup: 'rg' };
    if (arch === 'arm64') return { outName: 'rg-aarch64-unknown-linux-gnu', lookup: 'rg' };
  }
  fail(`Unsupported platform/arch: ${platform}/${arch}`);
}

function resolveSystemRg(lookup) {
  if (process.platform === 'win32') {
    const out = spawnSync('where', [lookup], { encoding: 'utf8' });
    if (out.status === 0) {
      const first = out.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      return first || null;
    }
    return null;
  }
  const out = spawnSync('which', [lookup], { encoding: 'utf8' });
  if (out.status === 0) {
    const first = out.stdout.trim();
    return first || null;
  }
  return null;
}

function main() {
  const spec = platformSpec();
  const projectRoot = process.cwd();
  const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');
  const outPath = path.join(binariesDir, spec.outName);

  fs.mkdirSync(binariesDir, { recursive: true });

  if (fs.existsSync(outPath)) {
    log(`rg sidecar already present: ${path.relative(projectRoot, outPath)}`);
    return;
  }

  const systemRg = resolveSystemRg(spec.lookup);
  if (!systemRg || !fs.existsSync(systemRg)) {
    const message = `Bundled rg not found and system rg not available. Install ripgrep or place binary at ${outPath}`;
    if (isStrictMode()) {
      fail(message);
    }
    warn(`${message}. Continuing without bundled rg (search will fallback to legacy in auto mode).`);
    return;
  }

  fs.copyFileSync(systemRg, outPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(outPath, 0o755);
  }

  log(`Installed rg sidecar from system binary: ${path.relative(projectRoot, outPath)}`);
}

main();
