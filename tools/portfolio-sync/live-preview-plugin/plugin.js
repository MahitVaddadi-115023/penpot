// plugin.js — Penpot plugin runtime entry for "Portfolio Live Preview".
//
// Runs in Penpot's plugin sandbox (NOT the iframe). Its only job is to open
// the UI panel (index.html, served by live-preview-server.mjs on :9005) and
// forward a couple of events down into it. The actual UI lives in index.html
// — keeping this file tiny matches the lorem-ipsum-plugin/poc-state-plugin
// pattern in the Penpot monorepo.
//
// The second arg to penpot.ui.open is a *path relative to the manifest URL*.
// We pass `?theme=...` (matching every reference plugin in
// penpot/plugins/apps/) so the iframe can theme itself; index.html is served
// at the root of :9005 by live-preview-server.mjs.

const theme = (() => { try { return penpot.theme; } catch { return 'dark'; } })();
penpot.ui.open('Portfolio Live Preview', `?theme=${theme}`, { width: 1100, height: 800 });

// Bubble theme changes down so the iframe can re-style if it ever wants to.
penpot.on('themechange', (newTheme) => {
  try { penpot.ui.sendMessage({ type: 'theme', content: newTheme }); } catch {}
});

// Surface the current page name (handy if the iframe ever wants to scope a
// sync to "just this page"). Safe-guarded — older runtimes may not expose
// currentPage at load time.
try {
  if (penpot.currentPage) {
    penpot.ui.sendMessage({ type: 'page', content: penpot.currentPage.name });
  }
} catch {}

penpot.on('pagechange', (page) => {
  try { penpot.ui.sendMessage({ type: 'page', content: page && page.name }); } catch {}
});
