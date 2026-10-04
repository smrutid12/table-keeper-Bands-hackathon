(function (global) {
  'use strict';

  const AUTH_KEY = 'tk_auth';

  function getAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setAuth(auth) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  }

  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Resolves with {status, json, ok} on any HTTP response (including 4xx/5xx).
  // Rejects only when the request never got a response at all (network
  // failure, dropped connection) -- the "lost response" case the UI must
  // treat as uncertain rather than failed.
  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const auth = getAuth();
    if (auth && auth.token) headers.Authorization = `Bearer ${auth.token}`;
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (e) { json = null; }
    }
    return { status: res.status, json, ok: res.status >= 200 && res.status < 300 };
  }

  function renderHeader(activePath) {
    const el = document.getElementById('site-header');
    if (!el) return;
    const auth = getAuth();
    const nav = [
      ['/', 'Search'],
      ['/lookup', 'Find a booking'],
    ];
    const navHtml = nav.map(([href, label]) => (
      `<a href="${href}"${href === activePath ? ' aria-current="page"' : ''}>${label}</a>`
    )).join('');

    let rightHtml;
    if (auth && auth.token) {
      rightHtml = `
        <span class="current-user" data-testid="current-user">${escapeHtml(auth.display_name || '')}</span>
        <button type="button" class="secondary" data-testid="logout-button" id="logout-button">Sign out</button>
      `;
    } else {
      rightHtml = `<a href="/login">Sign in</a> &nbsp; <a href="/signup">Sign up</a>`;
    }

    el.innerHTML = `
      <a class="brand" href="/">Tablekeeper</a>
      <nav class="site-nav">${navHtml}</nav>
      <div class="site-nav">${rightHtml}</div>
    `;

    const logoutBtn = document.getElementById('logout-button');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        clearAuth();
        window.location.href = '/';
      });
    }
  }

  global.TK = {
    getAuth, setAuth, clearAuth, escapeHtml, uid, deepEqual, apiFetch, renderHeader,
  };
}(window));
