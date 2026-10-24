// Copy the shared web app, API and schema into the desktop app folder before running or packaging.
import { cpSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(join(root, 'public'), join(here, 'web'), { recursive: true, filter: s => !/(ebot|octa)-runner\.json$|[\\/]work([\\/]|$)/.test(s) });
const apiSrc = readFileSync(join(root, 'functions', 'api', '[[path]].js'), 'utf8')
  .replaceAll("from '../../public/model-route.mjs'", "from './model-route.mjs'");
writeFileSync(join(here, 'api.js'), apiSrc);
copyFileSync(join(root, 'public', 'model-route.mjs'), join(here, 'model-route.mjs'));
copyFileSync(join(root, 'schema.sql'), join(here, 'schema.sql'));
console.log('web, api.js, model-route.mjs, schema.sql 已更新');
