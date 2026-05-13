/* Shared client-side bootstrap used by every page on the site.
 *
 * Responsibilities:
 *   1. Register the service worker so the app is installable.
 *   2. Manage the dark-mode preference, persist it to localStorage, and
 *      expose a global toggle (window.toggleTheme) that any navbar can call.
 *   3. Honor prefers-color-scheme on first visit and respond live to OS
 *      theme changes when the user has not explicitly opted in.
 */
(function () {
  'use strict';

  // ── Dark mode ─────────────────────────────────────────────────────────────
  var STORAGE_KEY = 'srf-theme';

  function getSystemPref() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } catch (_) { return 'light'; }
  }

  function readStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }

  function writeStored(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (_) { /* private mode */ }
  }

  function applyTheme(theme) {
    var t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    // Update any toggle buttons currently in the DOM.
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
      btns[i].textContent = t === 'dark' ? '☀️' : '🌙';
      btns[i].setAttribute('title', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
    // Update theme-color meta so the mobile browser chrome matches.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#1a1f1a' : '#3a6b35');
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    writeStored(next);
    applyTheme(next);
  }
  window.toggleTheme = toggleTheme;

  // Apply the saved or system theme as early as possible.
  applyTheme(readStored() || getSystemPref());

  // Live-update if the user hasn't picked one explicitly and the OS changes.
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () { if (!readStored()) applyTheme(getSystemPref()); };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  } catch (_) { /* no-op */ }

  // Wire up any toggle buttons present at DOMContentLoaded time.
  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(currentTheme());
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.preventDefault();
        toggleTheme();
      });
    }
  });

  // ── Service worker registration ───────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* offline-only feature */ });
    });
  }
})();
