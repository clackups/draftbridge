// The single HTML page of the web application. The page is the same
// for everybody (nothing user-specific is rendered on the server); the
// application script builds the interface from the configuration
// embedded below and the browser's session storage.

import type { Config } from './config.ts';
import { type Provider, publicInfo } from './providers.ts';
import { staticUrl } from './static.ts';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const GITHUB_URL = 'https://github.com/clackups/draftbridge';

// GitHub mark (octicon mark-github), inline so it follows the text color.
const GITHUB_ICON = '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">'
  + '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49'
  + '-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82'
  + '.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15'
  + '-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82'
  + ' 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48'
  + ' 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

export function appPage(cfg: Config, providers: Map<string, Provider>): string {
  const clientConfig = {
    baseUrl: cfg.baseUrl,
    siteName: cfg.siteName,
    providers: [...providers.values()].map(publicInfo),
  };
  // JSON inside a script element: "<" is escaped so that no "</script>"
  // can end it early.
  const json = JSON.stringify(clientConfig).replace(/</g, '\\u003c');
  const site = escapeHtml(cfg.siteName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${site}</title>
<link rel="icon" href="${staticUrl('favicon.svg')}">
<link rel="stylesheet" href="${staticUrl('app.css')}">
<script type="application/json" id="config">${json}</script>
<script src="${staticUrl('app.js')}" defer></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="${staticUrl('favicon.svg')}" alt="" class="logo"><span>${site}</span></a>
  <nav class="mainnav" id="nav"></nav>
</header>
<main class="container" id="main">
<noscript><section class="card narrow center"><p>${site} runs in your web browser and needs JavaScript.</p></section></noscript>
</main>
<footer class="footer">
  <div class="footer-text">Synchronize your <a href="https://github.com/clackups/draftling" rel="noopener">Draftling</a> with a Git repository over USB.</div>
  <div class="footer-end">
    <a class="github" href="${GITHUB_URL}" title="GitHub" aria-label="GitHub" rel="noopener">${GITHUB_ICON}</a>
  </div>
</footer>
</body>
</html>`;
}
