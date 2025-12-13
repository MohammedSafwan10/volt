#!/usr/bin/env node
/**
 * Build script for LSP sidecar binaries
 * 
 * This script creates wrapper scripts/executables for language servers
 * that can be bundled with Tauri's externalBin.
 * 
 * For production, these should be replaced with standalone executables
 * created using tools like pkg, nexe, or sea (Node.js single executable).
 */

const fs = require('fs');
const path = require('path');

// Target triple for the current platform
function getTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'win32') {
    return arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  } else if (platform === 'darwin') {
    return arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
  } else {
    return arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu';
  }
}

// Get executable extension for current platform
function getExeExtension() {
  return process.platform === 'win32' ? '.exe' : '';
}

const targetTriple = getTargetTriple();
const exeExt = getExeExtension();
const binariesDir = path.join(__dirname, '..', 'src-tauri', 'binaries');

// Ensure binaries directory exists
if (!fs.existsSync(binariesDir)) {
  fs.mkdirSync(binariesDir, { recursive: true });
}

// Language server configurations
const servers = [
  {
    name: 'typescript-language-server',
    entry: 'node_modules/typescript-language-server/lib/cli.mjs',
  },
  {
    name: 'tailwindcss-language-server',
    entry: 'node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server',
  },
  {
    name: 'vscode-eslint-language-server',
    entry: 'node_modules/vscode-langservers-extracted/bin/vscode-eslint-language-server',
  },
  {
    name: 'svelte-language-server',
    entry: 'node_modules/svelte-language-server/bin/server.js',
  },
  {
    name: 'vscode-html-language-server',
    entry: 'node_modules/vscode-langservers-extracted/bin/vscode-html-language-server',
  },
  {
    name: 'vscode-css-language-server',
    entry: 'node_modules/vscode-langservers-extracted/bin/vscode-css-language-server',
  },
  {
    name: 'vscode-json-language-server',
    entry: 'node_modules/vscode-langservers-extracted/bin/vscode-json-language-server',
  },
];

console.log(`Building LSP sidecars for ${targetTriple}...`);
console.log(`Output directory: ${binariesDir}`);

for (const server of servers) {
  const outputName = `${server.name}-${targetTriple}${exeExt}`;
  const outputPath = path.join(binariesDir, outputName);
  
  console.log(`Creating sidecar for ${server.name}...`);
  
  if (process.platform === 'win32') {
    // Windows: Create a batch file wrapper
    // Note: For production, use pkg to create a real .exe
    const batchPath = outputPath.replace('.exe', '.cmd');
    const batchContent = `@echo off\r\nnode "%~dp0..\\..\\${server.entry.replace(/\//g, '\\')}" %*\r\n`;
    fs.writeFileSync(batchPath, batchContent);
    
    // Create a placeholder .exe (Tauri expects .exe on Windows)
    // In production, this would be a real executable from pkg
    const exeContent = `@echo off\r\nnode "%~dp0..\\..\\${server.entry.replace(/\//g, '\\')}" %*\r\n`;
    fs.writeFileSync(outputPath, exeContent);
    
    console.log(`  Created: ${outputName}`);
  } else {
    // Unix: Create a shell script wrapper
    const shellContent = `#!/bin/sh\nexec node "$(dirname "$0")/../../${server.entry}" "$@"\n`;
    fs.writeFileSync(outputPath, shellContent);
    fs.chmodSync(outputPath, '755');
    console.log(`  Created: ${outputName}`);
  }
}

console.log('\n✓ Sidecar wrappers created successfully!');
console.log('\nNote: These are wrapper scripts that require Node.js to be installed.');
console.log('For standalone executables (no Node.js required), use:');
console.log('  npm install -g pkg');
console.log('  pkg <entry-file> --targets node18-win-x64,node18-macos-x64,node18-linux-x64');
