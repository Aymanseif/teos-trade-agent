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
 *
 * These two constants deliberately contain NO newline character. `patchIndex()`
 * detects the source file's own line-ending convention and supplies the break,
 * so the emitted file can never mix conventions. If you add a literal `\n` to
 * either of these, you reintroduce the bug described below - and a comment that
 * merely says "use a placeholder" is not enough to stop someone.
 *
 * A first version used a literal `\n` in the inserted lines, which was correct
 * on the machine it was written on and wrong everywhere the checkout used CRLF:
 * the source was entirely CRLF, the two inserted lines were bare LF, and the
 * emitted file had 141 CRLF plus 2 bare LF. That is a file with mixed line
 * endings, and it meant the generated `public/index.html` did not match the
 * committed blob - so the build was never actually reproducible across machines,
 * only stable within one working copy. `.gitattributes` now pins these paths to
 * LF as well, so the committed file and the generated file agree everywhere.
 */
const HEAD_LINE = '  <link rel="stylesheet" href="/vercel-shell.css">';
const BODY_LINE = '  <script src="/vercel-shell.js"></script>';

/**
 * The newline convention of `text`: `\r\n` if any line ends CRLF, else `\n`.
 *
 * Detected from the file rather than assumed from the platform, because git
 * decides this per repository and per developer (`core.autocrlf`), and a build
 * that guesses produces mixed endings in exactly the case nobody tests locally.
 */
export function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Guard against emitting a file with two different line endings.
 *
 * This is the check that would have caught the bug above at build time instead
 * of at the second clone. It is cheap and it is the kind of invariant that is
 * invisible in a diff and obvious to a browser or a reviewer.
 */
export function assertUniformNewlines(text, file) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && bareLf > 0) {
    throw new Error(
      `build: ${file} would be emitted with mixed line endings `
      + `(${crlf} CRLF and ${bareLf} bare LF). Every newline in the output must come `
      + 'from the same convention as the source, or the file is not reproducible.',
    );
  }
  return true;
}

/**
 * Apply the deployment patch to the dashboard markup. Pure: same input, same
 * output, no filesystem. Exported so a test can assert that the committed
 * `public/index.html` is exactly what this function produces - which is the
 * assertion that was missing.
 */
export function patchIndex(source, { file = 'src/dashboard/public/index.html' } = {}) {
  const nl = detectNewline(source);
  const out = insertOnce(
    insertOnce(source, '</head>', `${HEAD_LINE}${nl}</head>`, file),
    '</body>',
    `${BODY_LINE}${nl}</body>`,
    file,
  );
  assertUniformNewlines(out, file);
  return out;
}

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
  const patched = patchIndex(indexSource);
  writeFileSync(join(OUT, 'index.html'), patched, 'utf8');
  written.push(`index.html (patched, +${patched.length - indexSource.length} bytes, `
    + `newline ${detectNewline(indexSource) === '\r\n' ? 'CRLF' : 'LF'})`);

  // A deterministic build is verifiable: regenerating must reproduce the same
  // bytes. If a future edit introduces a timestamp, this is where it shows up.
  process.stdout.write(`build: wrote ${written.length} files to public/\n`);
  for (const line of written) process.stdout.write(`  - ${line}\n`);
  process.stdout.write('build: source of truth for the dashboard is src/dashboard/public/\n');
}

/**
 * Only build when this file is the process entry point.
 *
 * `tests/vercel.test.js` imports `patchIndex` from here to prove the committed
 * `public/index.html` is what this module generates. Without this guard, that
 * import would run `main()`, which deletes and recreates `public/` as a
 * side effect of loading a test file - and `node --test` runs files
 * concurrently, so it would race every other test that reads those assets.
 *
 * A module that does work on import is a module nobody can safely test.
 */
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return resolve(invoked) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
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
}