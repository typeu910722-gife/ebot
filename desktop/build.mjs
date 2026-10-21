// Copy the shared web app, API and schema into the desktop app folder before running or packaging.
import { cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(join(root, 'public'), join(here, 'web'), { recursive: true, filter: s => !/ebot-runner\.json$|[\\/]work([\\/]|$)/.test(s) });
copyFileSync(join(root, 'functions', 'api', '[[path]].js'), join(here, 'api.js'));
copyFileSync(join(root, 'schema.sql'), join(here, 'schema.sql'));
console.log('web, api.js, schema.sql 已更新');
