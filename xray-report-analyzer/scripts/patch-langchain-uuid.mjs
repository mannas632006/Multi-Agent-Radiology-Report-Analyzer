// Fixup for a packaging bug in n8n@2.28.7's dependency tree.
//
// n8n 2.28.7 bundles `@microsoft/agents-a365-tooling-extensions-langchain`,
// whose langgraph packages `require("@langchain/core/utils/uuid")` for the `v5`
// and `v6` helpers. But the resolved `@langchain/core@1.1.41` ships no
// `utils/uuid` module at all (no export mapping, no file). The n8n
// CommandRegistry imports every command inside a `try {} catch {}` that SWALLOWS
// the error, so the failure surfaces only as the misleading
// `Error: Command "start" not found` — the server never boots.
//
// `@langchain/core/utils/uuid` is just a thin re-export of the `uuid` package,
// which is present (v11.x, exposes v6/v5/v4/...). This script adds the missing
// `./utils/uuid` export mapping and creates shim files that re-export `uuid`,
// for EVERY installed @langchain/core that lacks it. Idempotent; safe to re-run.
//
// Run after any (re)install of n8n:  node scripts/patch-langchain-uuid.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const N8N_NM = 'C:\\Users\\manna\\AppData\\Roaming\\npm\\node_modules\\n8n\\node_modules';

// Recursively find every directory that is a @langchain/core package.
function findCoreDirs(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(root, e.name);
    if (full.replace(/\\/g, '/').endsWith('@langchain/core')) {
      if (existsSync(join(full, 'package.json'))) out.push(full);
    }
    if (e.name === 'node_modules' || e.name.startsWith('@') || full.includes('node_modules')) {
      findCoreDirs(full, out);
    }
  }
  return out;
}

const CJS = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n// Shim added by patch-langchain-uuid.mjs — re-export the uuid package.\nmodule.exports = require("uuid");\n';
const ESM = '// Shim added by patch-langchain-uuid.mjs — re-export the uuid package.\nexport * from "uuid";\n';
const DTS = 'export * from "uuid";\n';

function patchCore(dir) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.exports || typeof pkg.exports !== 'object') return 'no exports map — skipped';

  const utilsDir = join(dir, 'dist', 'utils');
  if (!existsSync(utilsDir)) return 'no dist/utils — skipped (likely a nested subdir layout)';

  // If ./utils/uuid already resolves to a real file, leave it alone.
  const existing = pkg.exports['./utils/uuid'];
  const resolvesToReal = existing && (() => {
    const cand = existing?.require?.default || existing?.import?.default || existing?.default;
    return cand && existsSync(join(dir, cand));
  })();
  if (resolvesToReal) return 'already valid — skipped';

  // Write shim files next to the other utils (mirrors env.cjs/.js/.d.cts/.d.ts).
  writeFileSync(join(utilsDir, 'uuid.cjs'), CJS, 'utf8');
  writeFileSync(join(utilsDir, 'uuid.js'), ESM, 'utf8');
  writeFileSync(join(utilsDir, 'uuid.d.cts'), DTS, 'utf8');
  writeFileSync(join(utilsDir, 'uuid.d.ts'), DTS, 'utf8');

  pkg.exports['./utils/uuid'] = {
    require: { types: './dist/utils/uuid.d.cts', default: './dist/utils/uuid.cjs' },
    import: { types: './dist/utils/uuid.d.ts', default: './dist/utils/uuid.js' },
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return 'PATCHED';
}

const dirs = findCoreDirs(N8N_NM);
if (dirs.length === 0) { console.error('No @langchain/core found under', N8N_NM); process.exit(1); }
let patched = 0;
for (const d of dirs) {
  const ver = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version;
  const res = patchCore(d);
  if (res === 'PATCHED') patched++;
  console.log(`  [${res}] v${ver}  ${d.replace(N8N_NM, '...')}`);
}
console.log(`\nDone. ${patched} package(s) patched.`);
