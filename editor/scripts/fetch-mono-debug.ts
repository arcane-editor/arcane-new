#!/usr/bin/env bun
/**
 * Vendor the vscode-mono-debug DAP adapter (MIT) used for Unity Mono debugging.
 *
 * The adapter is a .NET assembly run under the system Mono runtime. We do NOT
 * commit the binary; this script fetches a released build into
 * `src-tauri/binaries/mono-debug/` where `dap.rs::find_adapter` looks for it.
 *
 * Sources (pick one):
 *   - Build from source: https://github.com/microsoft/vscode-mono-debug
 *       git clone, then `dotnet build` / msbuild → bin/Release/mono-debug.exe
 *   - Or extract `mono-debug.exe` (+ its dependency DLLs) from the published
 *     VS Code extension VSIX (ms-vscode.mono-debug) under its `bin/` folder.
 *
 * Place the result at:
 *   src-tauri/binaries/mono-debug/mono-debug.exe   (+ sibling DLLs)
 *
 * Debugging degrades gracefully when this is absent: `check_mono_installed`
 * reports `available: false` and the IDE shows "Install Mono to enable
 * debugging" instead of failing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const target = join(import.meta.dir, '..', 'src-tauri', 'binaries', 'mono-debug', 'mono-debug.exe');

if (existsSync(target)) {
  console.log(`[fetch-mono-debug] adapter already present at ${target}`);
  process.exit(0);
}

console.error(
  [
    '[fetch-mono-debug] mono-debug adapter not vendored.',
    'This script is a documented stub — automated fetching of a license-clean',
    'prebuilt binary is intentionally manual. To enable Unity debugging:',
    '',
    '  1. Build vscode-mono-debug (MIT) from source, or extract mono-debug.exe',
    '     from the ms-vscode.mono-debug VSIX.',
    `  2. Copy mono-debug.exe (+ DLLs) to:`,
    `     ${target}`,
    '  3. Install Mono:  brew install mono   (macOS)',
    '',
    'Until then the debugger degrades gracefully (no crash).',
  ].join('\n'),
);
process.exit(0);
