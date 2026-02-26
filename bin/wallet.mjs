#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const entry = join(root, 'src', 'index.ts');

const result = spawnSync(tsx, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(result.status ?? 1);
