// Generate every platform icon from the current brand SVG via the project-pinned Tauri CLI.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const source = path.join(root, 'src-tauri', 'icons', 'brand-icon-source.svg');
const output = path.join(root, 'src-tauri', 'icons');
if (!fs.existsSync(tauri)) {
  console.error('Tauri CLI is missing; install project dependencies first.');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error('Brand icon source SVG is missing:', source);
  process.exit(1);
}
const result = spawnSync(tauri, ['icon', source, '--output', output], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
