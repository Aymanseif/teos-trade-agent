#!/usr/bin/env node
/**
 * TEOS Trade Agent - scripts/build.js
 *
 * Generates `public/`, the Vercel deployment's static output.
 *
 * WHY THIS IS A BUILD STEP AND NOT A COPY
 *
 * The Vercel dashboard must be the existing dashboard: same markup, same
 * rendering code, same stylesheet, same visual identity. The way to guarantee
 * that without maintaining two copies forever is to have exactly one source of
 * truth (`src/dashboard/public/`) and generate the deployed files from it on
 * every build. Two files are copied byte for byte; one is copied with a single
 * documented insertion, and the insertion is asserted rather than assumed.
 *
 * DETERMINISM
 *
 * Running this twice produces identical bytes. There is no timestamp, no
 * random value, no hash of the clock and no environment read. That matters
 * because the build output is committed to nothing and compared by nothing -
 * it is regenerated on Vercel - so a build that drifted between runs would be
 * indistinguishable from a real change.
 *
 * FAIL LOUDLY
 *
 * If either anchor string is missing or appears more than once, the build
 * fails with a non-zero exit rather than producing a page that silently lost its
 * script tag. A deployment that looks right and is not running its shell script
 * is exactly the failure this script exists to make impossible.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = join(ROOT, 'src', 'dashboard', 'public');
const SHELL = join(ROOT, 'src', 'vercel', 'public');
const OUT = join(ROOT, 'public');

/** Copied byte for byte: identical rendering on both deployments. */
const VERBATIM = ['app.js', 'style.css'];

/** Copied from the Vercel-only source directory. */
const FROM_SHELL = { 'vercel-shell.js': 'shell.js', 'vercel-shell.css': 'shell.css' };

/**
 * The two insertions applied to `index.html`.
 *
 * `head` adds the shell stylesheet; `body` adds the shell script. Both anchors
 * are plain closing tags that appear exactly once in the document, and both are
 * asserted below, so an upstream edit to the dashboard either keeps the page
 * correct or fails the build - it cannot produce a page that is quietly missing
 * its chrome.
 */
const HEAD_INSERT = '  <link rel="stylesheet" href="/vercel-shell.css">\n</head>';
const BODY_INSERT = '  <script src="/vercel-shell.js"></script>\n</body>';

/** Replace `anchor` exactly once, or throw. Never silently. */
function insertOnce(text, anchor, replacement, file) {
  const first = text.indexOf(anchor);
  if (first === -1) {
    throw new Error(
      `build: anchor ${JSON.stringify(anchor)} not found in ${file}. `
      + 'The dashboard markup changed and the Vercel build patch must be updated to match. '
      + 'Refusing to emit a page without its deployment chrome.',
    );
  }
  if (text.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(
      `build: anchor ${JSON.stringify(anchor)} appears more than once in ${file}. `
      + 'The patch is ambiguous and was not applied.',
    );
  }
  return text.slice(0, first) + replacement + text.slice(first + anchor.length);
}

function main() {
  const written = [];

  // Start from a clean directory so a renamed or deleted dashboard asset cannot
  // survive as a stale file in the deployment.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const name of VERBATIM) {
    const bytes = readFileSync(join(SOURCE, name));
    writeFileSync(join(OUT, name), bytes);
    written.push(`${name} (verbatim, ${bytes.length} bytes)`);
  }

  for (const [outName, srcName] of Object.entries(FROM_SHELL)) {
    const bytes = readFileSync(join(SHELL, srcName));
    writeFileSync(join(OUT, outName), bytes);
    written.push(`${outName} (from src/vercel/public/${srcName}, ${bytes.length} bytes)`);
  }

  const indexSource = readFileSync(join(SOURCE, 'index.html'), 'utf8');
  const patched = insertOnce(
    insertOnce(indexSource, '</head>', HEAD_INSERT, 'src/dashboard/public/index.html'),
    '</body>',
    BODY_INSERT,
    'src/dashboard/public/index.html',
  );
  writeFileSync(join(OUT, 'index.html'), patched, 'utf8');
  written.push(`index.html (patched, +${patched.length - indexSource.length} bytes)`);

  // A deterministic build is verifiable: regenerating must reproduce the same
  // bytes. If a future edit introduces a timestamp, this is where it shows up.
  process.stdout.write(`build: wrote ${written.length} files to public/\n`);
  for (const line of written) process.stdout.write(`  - ${line}\n`);
  process.stdout.write('build: source of truth for the dashboard is src/dashboard/public/\n');
}

// A missing source directory is a build failure with a useful message, not a
// stack trace from deep inside readFileSync.
if (!existsSync(SOURCE)) {
  process.stderr.write(`build: dashboard source directory missing: ${SOURCE}\n`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`build: FAILED - ${err.message}\n`);
  process.exit(1);
}