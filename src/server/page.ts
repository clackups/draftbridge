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

// The page shell shared by the application and the privacy statement.
// `head` adds elements to <head>; `body` fills <main>.
function layout(cfg: Config, title: string, head: string, body: string): string {
  const site = escapeHtml(cfg.siteName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${staticUrl('favicon.svg')}">
<link rel="stylesheet" href="${staticUrl('app.css')}">${head}
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="${staticUrl('favicon.svg')}" alt="" class="logo"><span>${site}</span></a>
  <nav class="mainnav" id="nav"></nav>
</header>
<main class="container" id="main">
${body}
</main>
<footer class="footer">
  <div class="footer-text">Synchronize your <a href="https://github.com/clackups/draftling" rel="noopener">Draftling</a> with a Git repository over USB.</div>
  <div class="footer-end">
    <a href="/privacy">Privacy</a>
    <a class="github" href="${GITHUB_URL}" title="GitHub" aria-label="GitHub" rel="noopener">${GITHUB_ICON}</a>
  </div>
</footer>
</body>
</html>`;
}

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
  return layout(cfg, cfg.siteName, `
<script type="application/json" id="config">${json}</script>
<script src="${staticUrl('app.js')}" defer></script>`,
  `<noscript><section class="card narrow center"><p>${site} runs in your web browser and needs JavaScript.</p></section></noscript>`);
}

// The privacy statement, rendered on the server (no script needed).
export function privacyPage(cfg: Config): string {
  const site = escapeHtml(cfg.siteName);
  return layout(cfg, `Privacy statement - ${cfg.siteName}`, '', `<section class="card privacy">
<h1>Privacy statement</h1>
<p>This statement explains how ${site} treats your work and your account.</p>

<h2>Your work belongs to you</h2>
<p>All rights to the documents and other content that you synchronize through ${site} belong to you or to the respective rights holders. Using ${site} does not transfer any rights to ${site}.</p>

<h2>We do not keep, use or distribute your work</h2>
<p>${site} does not store your documents. They travel between your Draftling and your Git repository through your web browser, and pass through the ${site} server only on their way to and from the Git host (GitHub or Codeberg), because Git hosts do not accept such requests directly from web pages. ${site} does not record, use, analyse, sell, publish or distribute your work in any way, including for advertising or for training software.</p>

<h2>Your login</h2>
<p>You log in with your GitHub or Codeberg account. The access token that the Git host issues passes through the ${site} server when you log in and with each request to the Git host, but the server never stores it. Your web browser keeps it in this tab's session storage, and it is gone when you close the tab or log out. ${site} receives no password.</p>

<h2>What stays in your browser</h2>
<p>Besides the login, your web browser remembers the repository you last chose for each account, so that it is selected the next time. This stays on your computer and is never sent to ${site}. ${site} uses no cookies and no tracking or analytics.</p>

<h2>Your Git host</h2>
<p>Your documents are stored in the repository you choose on GitHub or Codeberg, under your account there. That service's own terms and privacy policy apply to them. Whether the repository is private or public is up to you and the settings you choose on the Git host.</p>
</section>`);
}
