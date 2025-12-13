import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

const NODE_VERSION = process.env.VOLT_NODE_VERSION || '20.11.1';

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[sidecars:node] ${msg}`);
}

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`[sidecars:node] ERROR: ${msg}`);
  process.exit(1);
}

function getPlatformSpec() {
  const { platform, arch } = process;

  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') {
      fail(`Unsupported Windows arch: ${arch}`);
    }
    return {
      nodeDist: `node-v${NODE_VERSION}-win-${arch}.zip`,
      tauriTriple: arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc',
      outputName: arch === 'x64' ? 'node-x86_64-pc-windows-msvc.exe' : 'node-aarch64-pc-windows-msvc.exe',
      extract: 'zip',
    };
  }

  if (platform === 'darwin') {
    if (arch !== 'x64' && arch !== 'arm64') {
      fail(`Unsupported macOS arch: ${arch}`);
    }
    const distArch = arch === 'x64' ? 'x64' : 'arm64';
    return {
      nodeDist: `node-v${NODE_VERSION}-darwin-${distArch}.tar.gz`,
      tauriTriple: arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin',
      outputName: arch === 'x64' ? 'node-x86_64-apple-darwin' : 'node-aarch64-apple-darwin',
      extract: 'tar',
    };
  }

  if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') {
      fail(`Unsupported Linux arch: ${arch}`);
    }
    const distArch = arch === 'x64' ? 'x64' : 'arm64';
    return {
      nodeDist: `node-v${NODE_VERSION}-linux-${distArch}.tar.xz`,
      tauriTriple: arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu',
      outputName: arch === 'x64' ? 'node-x86_64-unknown-linux-gnu' : 'node-aarch64-unknown-linux-gnu',
      extract: 'tar',
    };
  }

  fail(`Unsupported platform: ${platform}`);
}

function downloadTo(url, outFile) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outFile);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.rmSync(outFile, { force: true });
          downloadTo(res.headers.location, outFile).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.rmSync(outFile, { force: true });
          reject(new Error(`Download failed (${res.statusCode})`));
          return;
        }

        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close();
        fs.rmSync(outFile, { force: true });
        reject(err);
      });
  });
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed with exit code ${res.status}`);
  }
}

async function main() {
  const spec = getPlatformSpec();

  const projectRoot = process.cwd();
  const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');
  const outPath = path.join(binariesDir, spec.outputName);

  if (fs.existsSync(outPath)) {
    log(`Node sidecar already present: ${path.relative(projectRoot, outPath)}`);
    return;
  }

  fs.mkdirSync(binariesDir, { recursive: true });

  const distUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${spec.nodeDist}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-node-'));
  const archivePath = path.join(tmpDir, spec.nodeDist);
  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir);

  log(`Downloading ${distUrl}`);
  await downloadTo(distUrl, archivePath).catch((e) => fail(String(e)));

  log(`Extracting ${spec.nodeDist}`);
  if (spec.extract === 'zip') {
    // Use PowerShell Expand-Archive for Windows.
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'`,
    ]);

    // node.exe is in node-vX-win-ARCH/node.exe
    const extractedRoot = path.join(extractDir, `node-v${NODE_VERSION}-win-${process.arch}`);
    const nodeExe = path.join(extractedRoot, 'node.exe');
    if (!fs.existsSync(nodeExe)) {
      fail(`Expected node.exe not found at ${nodeExe}`);
    }
    fs.copyFileSync(nodeExe, outPath);
  } else {
    // tar for mac/linux
    // GNU tar can extract .tar.gz and .tar.xz (if xz is available).
    run('tar', ['-xf', archivePath, '-C', extractDir]);

    const prefix =
      process.platform === 'darwin'
        ? `node-v${NODE_VERSION}-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`
        : `node-v${NODE_VERSION}-linux-${process.arch === 'x64' ? 'x64' : 'arm64'}`;

    const nodeBin = path.join(extractDir, prefix, 'bin', 'node');
    if (!fs.existsSync(nodeBin)) {
      fail(`Expected node binary not found at ${nodeBin}`);
    }

    fs.copyFileSync(nodeBin, outPath);
    fs.chmodSync(outPath, 0o755);
  }

  log(`Installed Node sidecar: ${path.relative(projectRoot, outPath)} (tauri triple: ${spec.tauriTriple})`);
}

main();
