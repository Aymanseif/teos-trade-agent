/**
 * TEOS Trade Agent - vercel/public/shell.js
 *
 * The Vercel-only chrome that wraps the existing dashboard.
 *
 * This file is copied to `public/vercel-shell.js` by `npm run build` and is the
 * ONLY difference between the local dashboard and the Vercel one. Everything
 * else - `index.html`, `app.js`, `style.css` - is the same file the local
 * dashboard serves, copied byte for byte by the build script, so the two pages
 * cannot drift apart in appearance or in behaviour.
 *
 * Its job is to make three things unmissable that a well-designed dashboard
 * would otherwise leave ambiguous:
 *
 *   1. That this is PAPER.
 *   2. That this deployment is READ-ONLY and starts no worker.
 *   3. That "no data" means "no data here", not "no trading has happened".
 *
 * The third is the one that matters. A blank account panel on a page with no
 * explanation reads as a quiet account. It is not: it is a serverless function
 * with no database attached. This script says so in those words.
 */

(function () {
  'use strict';

  var BANNER_ID = 'vercel-banner';
  var NOTICE_ID = 'vercel-no-data';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * The banner. Built in JS rather than injected into the HTML at build time
   * so that the generated `public/index.html` differs from
   * `src/dashboard/public/index.html` by exactly one script tag. A smaller
   * build-time patch is a patch with fewer ways to be wrong.
   */
  function installBanner() {
    if (document.getElementById(BANNER_ID)) return;
    var header = document.querySelector('header');
    if (!header) return;

    var bar = el('div', 'vercel-banner');
    bar.id = BANNER_ID;

    var tag = el('span', 'vercel-tag', 'PAPER \u00b7 READ-ONLY');
    var text = el('span', 'vercel-text');
    text.textContent =
      'Vercel presentation layer. It starts no trading worker, holds no database, '
      + 'and cannot place or change an order. The worker runs locally.';

    bar.appendChild(tag);
    bar.appendChild(text);
    header.insertBefore(bar, header.firstChild);

    // The local footer says "loopback only", which is true here only in the
    // sense that this deployment is reachable by anyone. Correcting it in place
    // is more honest than leaving a security claim that does not apply.
    var footer = document.querySelector('footer');
    if (footer) {
      var note = footer.querySelector('.vercel-footer-note');
      if (!note) {
        note = el('span', 'muted vercel-footer-note');
        // `replaceChildren()` rather than `innerHTML = ''`: this file never
        // assigns markup from a string, and a page that renders data it fetched
        // itself should not contain an innerHTML sink at all.
        note.replaceChildren();
        note.appendChild(document.createTextNode('Read-only public deployment '));
        var code = el('code', null, 'GET');
        note.appendChild(code);
        note.appendChild(document.createTextNode(' only \u00b7 no persistent worker '));
        code = el('code', null, 'no live trading');
        note.appendChild(code);
        note.appendChild(document.createTextNode(' \u00b7 control the agent from the local CLI'));
        footer.insertBefore(note, footer.firstChild);
      }
    }
  }

  /**
   * The "no data" notice.
   *
   * Two distinct messages, because they mean different things and collapsing
   * them would be a lie in one direction or the other:
   *
   *   - The endpoint answered but has no database. This is the designed
   *     behaviour of a read-only layer with no snapshot attached.
   *   - The endpoint did not answer at all. That is an error, and saying
   *     "no data" instead of "unreachable" would hide a broken deployment.
   */
  function showNotice(kind, message) {
    if (document.getElementById(NOTICE_ID)) return;
    var main = document.querySelector('main');
    if (!main) return;
    var note = el('div', 'vercel-notice ' + kind);
    note.id = NOTICE_ID;
    note.appendChild(el('strong', null, message));
    main.insertBefore(note, main.firstChild);
  }

  function install() {
    installBanner();

    fetch('/api/healthz', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (h) {
        // The badge is the dashboard's own; only overwrite it if the endpoint
        // is unreachable and the default would otherwise be a guess.
        var badge = document.getElementById('mode-badge');
        if (badge && h.mode) {
          badge.textContent = h.mode;
          badge.className = 'badge ' + (h.mode === 'BACKTEST' ? 'backtest' : 'paper');
        }
        if (h.noDataMessage) showNotice('empty', h.noDataMessage);
      })
      .catch(function (err) {
        showNotice('error',
          'Cannot reach this deployment\u2019s read-only API (' + err.message + '). '
          + 'This is an availability problem, not an empty account.');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
}());