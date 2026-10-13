// Draftbridge web application: log in with GitHub or Codeberg, pick a
// repository, connect the Draftling over USB (Web Serial, Kermit) and
// synchronize. Everything happens in this browser tab; the server only
// relays requests to the Git host.

import { type Auth, type ClientConfig, type ProviderInfo, accessToken, finishLogin, loadAuth, logout, startLogin } from './auth.ts';
import { type HostApi, type Repo, type User, hostApi } from './api.ts';
import { h, replace } from './dom.ts';
import { SerialChannel, webSerial } from './serial.ts';
import { storage } from './storage.ts';
import { KermitClient } from '../core/kermit/client.ts';
import { DeviceRepo, hasKnownExtension } from '../core/device.ts';
import { type GitConfig, normalizePath, parseGitConfig, sameRepo, updateGitConfig } from '../core/gitcfg.ts';
import { GitHttpClient, basicAuth } from '../core/git/http.ts';
import { type SyncResult, UnsupportedFilesError, summarize, sync, validBranch } from '../core/sync.ts';

const cfg = JSON.parse(document.getElementById('config')?.textContent ?? '{}') as ClientConfig;
const main = document.getElementById('main') as HTMLElement;
const nav = document.getElementById('nav') as HTMLElement;

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

interface DeviceState {
  channel: SerialChannel;
  client: KermitClient;
  status: 'probing' | 'ready' | 'silent' | 'closed';
  configText: string | null;
  config: GitConfig | null;
  error: string | null;
}

const state = {
  auth: null as Auth | null,
  provider: null as ProviderInfo | null,
  api: null as HostApi | null,
  user: null as User | null,
  repos: null as Repo[] | null,
  reposError: null as string | null,
  filter: '',
  creating: false,
  createError: null as string | null,
  selected: null as Repo | null,
  check: { status: 'idle', message: '', files: [] as string[] } as { status: 'idle' | 'checking' | 'ok' | 'bad' | 'error'; message: string; files: string[] },
  device: null as DeviceState | null,
  branch: '',
  path: '',
  syncing: false,
  progress: [] as string[],
  kermitLog: [] as string[],
  result: null as SyncResult | null,
  syncError: null as string | null,
  unsupported: [] as string[],
};

// ---- page structure ------------------------------------------------------

const sections = {
  repo: h('section.card'),
  device: h('section.card'),
  sync: h('section.card'),
};

function flash(kind: 'ok' | 'error', text: string): HTMLElement {
  return h(`div.flash.flash-${kind}`, { role: 'status' }, text);
}

function renderNav(): void {
  if (!state.user || !state.provider) {
    replace(nav);
    return;
  }
  replace(nav,
    h('span.muted', `${state.user.login} (${state.provider.label})`),
    h('button.linkbtn', { type: 'button', onclick: () => { logout(); location.assign('/'); } }, 'Log out'));
}

function renderLanding(error: string | null): void {
  const serialOk = webSerial() !== null;
  replace(main,
    h('section.hero',
      h('h1', cfg.siteName),
      h('p.lead', 'Synchronize your Draftling with a Git repository on GitHub or Codeberg through a USB cable, without WiFi.')),
    error ? flash('error', error) : null,
    !serialOk ? h('div.warning', 'This browser cannot talk to USB serial devices. Please use Chrome, Edge or Opera on a computer.') : null,
    h('section.card.narrow',
      h('h2', 'Log in'),
      h('p.muted', 'Log in with the account that holds (or will hold) your documents.'),
      cfg.providers.length
        ? h('div.providers', cfg.providers.map((p) => h('button.btn.btn-provider', { type: 'button', onclick: () => void startLogin(cfg, p) }, `Continue with ${p.label}`)))
        : h('p.error', 'No login methods are configured on this server.')),
    h('section.landing-text',
      h('h2', 'How it works'),
      h('ol',
        h('li', 'Log in and choose the repository for your documents, or create a new one.'),
        h('li', 'Connect the Draftling to this computer with a USB cable. On the Draftling, press F1, choose "Sync via browser" and Start.'),
        h('li', 'Click Synchronize. Your documents travel between the Draftling and the repository the same way as with Git sync over WiFi: every version is kept, and edits made on both sides are merged.')),
      h('p.muted.small', 'Draftbridge keeps nothing on its server: your login stays in this browser tab, and your documents only pass through on their way to the Git host.')));
}

function renderApp(): void {
  renderNav();
  replace(main, sections.repo, sections.device, sections.sync);
  renderRepo();
  renderDevice();
  renderSync();
}

// ---- 1. repository -------------------------------------------------------

const repoKey = () => `draftbridge.repo.${state.provider?.id}.${state.user?.login}`;

function renderRepo(): void {
  const s = state;
  const head = h('div.pagehead', h('h2', '1. Repository'));
  if (s.selected) {
    const r = s.selected;
    replace(sections.repo, head,
      h('p', h('strong', r.fullName), ' ', h('span.badge' + (r.private ? '' : '.badge-public'), r.private ? 'private' : 'public'), ' ',
        h('a.small', { href: r.htmlUrl, target: '_blank', rel: 'noopener' }, 'open'), ' ',
        s.syncing ? null : h('button.linkbtn.small', { type: 'button', onclick: () => { s.selected = null; s.check = { status: 'idle', message: '', files: [] }; s.result = null; s.syncError = null; renderAll(); } }, 'change')),
      checkView());
    return;
  }
  const list = h('ul.repolist');
  const fill = () => {
    const f = s.filter.toLowerCase();
    const shown = (s.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(f)).slice(0, 100);
    replace(list, shown.length
      ? shown.map((r) => h('li', h('button.repo-pick', { type: 'button', onclick: () => void selectRepo(r) },
        h('span.repo-name', r.fullName), ' ',
        h('span.badge' + (r.private ? '' : '.badge-public'), r.private ? 'private' : 'public'),
        r.empty ? h('span.badge', 'empty') : null)))
      : h('li.muted', s.repos?.length ? 'No repository matches.' : 'You have no repositories yet.'));
  };
  let body: HTMLElement;
  if (s.reposError) {
    body = h('div', flash('error', s.reposError), h('button.btn.btn-secondary', { type: 'button', onclick: () => void loadRepos() }, 'Try again'));
  } else if (!s.repos) {
    body = h('p.muted', 'Loading your repositories...');
  } else {
    const filter = h('input', { type: 'text', placeholder: 'Filter repositories', value: s.filter, 'aria-label': 'Filter repositories' }) as HTMLInputElement;
    filter.addEventListener('input', () => { s.filter = filter.value; fill(); });
    fill();
    body = h('div.stack', filter, list);
  }
  replace(sections.repo, head,
    h('p.muted', 'Choose the repository the Draftling synchronizes with. It may only contain Markdown (.md), text (.txt) and Fountain (.fountain) files.'),
    body,
    createForm());
}

function createForm(): HTMLElement {
  const s = state;
  const name = h('input', { type: 'text', name: 'name', required: true, pattern: '[A-Za-z0-9_.\\-]+', maxlength: 100, placeholder: 'my-writing' }) as HTMLInputElement;
  const pub = h('input', { type: 'checkbox', name: 'public' }) as HTMLInputElement;
  const form = h('form.stack',
    h('label', 'Name', name),
    h('label.check', pub, h('span', 'Public: anybody on the internet can read the documents. Leave this unchecked to keep the repository private (only you, and people you invite, can see it).')),
    s.createError ? flash('error', s.createError) : null,
    h('div', h('button.btn', { type: 'submit', disabled: s.creating }, s.creating ? 'Creating...' : 'Create repository'))) as HTMLFormElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void createRepo(name.value.trim(), !pub.checked);
  });
  return h('details.newrepo', s.createError ? { open: true } : {}, h('summary', 'Create a new repository'), form);
}

function checkView(): HTMLElement | null {
  const c = state.check;
  if (c.status === 'checking') return h('p.muted', 'Checking the files in the repository...');
  if (c.status === 'ok') return h('p.ok-text', c.message);
  if (c.status === 'error') return flash('error', c.message);
  if (c.status === 'bad') {
    return h('div.flash.flash-error',
      h('p', h('strong', 'This repository cannot be synchronized.'), ' Draftling only handles Markdown (.md), text (.txt) and Fountain (.fountain) files, and the repository contains other files:'),
      h('ul.mono.small', c.files.slice(0, 30).map((f) => h('li', f)), c.files.length > 30 ? h('li', `... and ${c.files.length - 30} more`) : null),
      h('p', 'Choose another repository or create a new one.'));
  }
  return null;
}

async function loadRepos(): Promise<void> {
  state.reposError = null;
  state.repos = null;
  renderRepo();
  try {
    state.repos = await state.api!.repos();
    const last = storage.local.get(repoKey());
    const again = last ? state.repos.find((r) => r.fullName === last) : undefined;
    if (again && !state.selected) {
      await selectRepo(again);
      return;
    }
  } catch (err) {
    state.reposError = `Your repositories could not be loaded: ${message(err)}`;
  }
  renderRepo();
}

async function selectRepo(r: Repo): Promise<void> {
  state.selected = r;
  state.result = null;
  state.syncError = null;
  state.unsupported = [];
  state.check = { status: 'checking', message: '', files: [] };
  storage.local.set(repoKey(), r.fullName);
  setDefaults();
  renderAll();
  try {
    const t = await state.api!.tree(r, r.defaultBranch);
    if (t.files === null) {
      state.check = { status: 'ok', message: 'The repository is large; its files are checked when you synchronize.', files: [] };
    } else {
      const bad = t.files.filter((f) => !hasKnownExtension(f));
      if (bad.length) state.check = { status: 'bad', message: '', files: bad };
      else if (t.empty) state.check = { status: 'ok', message: 'The repository is empty: the first synchronization fills it with the documents on the Draftling.', files: [] };
      else state.check = { status: 'ok', message: `${t.files.length} document(s) in the repository.`, files: [] };
    }
  } catch (err) {
    state.check = { status: 'error', message: `The repository could not be checked: ${message(err)}`, files: [] };
  }
  renderAll();
}

async function createRepo(name: string, isPrivate: boolean): Promise<void> {
  if (!REPO_NAME.test(name) || name === '.' || name === '..') {
    state.createError = 'Use letters, digits, "-", "_" and "." only.';
    renderRepo();
    return;
  }
  state.creating = true;
  state.createError = null;
  renderRepo();
  try {
    const repo = await state.api!.createRepo(name, isPrivate);
    state.repos = [repo, ...(state.repos ?? [])];
    state.creating = false;
    await selectRepo({ ...repo, empty: true });
  } catch (err) {
    state.creating = false;
    state.createError = `The repository could not be created: ${message(err)}`;
    renderRepo();
  }
}

// ---- 2. device -------------------------------------------------------------

// Draftling asks the client to wait 10 s; it answers much faster unless
// the SD card is busy.
const KERMIT_TIMEOUT_MS = 6000;
const KERMIT_RETRIES = 5;

const BAUD_RATES = [115200, 230400, 460800, 921600, 57600, 9600];

function renderDevice(): void {
  const d = state.device;
  const head = h('div.pagehead', h('h2', '2. Draftling'));
  const howto = h('ol.small',
    h('li', 'Connect the Draftling to this computer with a USB cable.'),
    h('li', 'On the Draftling, press F1, choose "Sync via browser" (V) and then Start. The status bar shows "Sync via browser active".'),
    h('li', 'Click Connect and pick the Draftling\'s serial port (on Linux /dev/ttyACM0 or /dev/ttyUSB0, on macOS usbmodem or usbserial, on Windows a COM port).'));
  if (!webSerial()) {
    replace(sections.device, head, h('div.warning', 'This browser cannot talk to USB serial devices. Please use Chrome, Edge or Opera on a computer.'));
    return;
  }
  if (!d || d.status === 'closed') {
    const saved = Number(storage.local.get('draftbridge.baud')) || 115200;
    const baud = h('select', { 'aria-label': 'Speed' }, BAUD_RATES.map((b) => h('option', { value: b, selected: b === saved }, `${b} bit/s`))) as HTMLSelectElement;
    replace(sections.device, head, howto,
      d?.error ? flash('error', d.error) : null,
      h('div.row',
        h('label', 'Speed', baud),
        h('div', h('button.btn', { type: 'button', onclick: () => void connect(Number(baud.value)) }, 'Connect'))),
      h('p.muted.small', 'The speed only matters for boards with a USB-to-serial chip (such as the Seeed reTerminal); 115200 is right for them.'));
    return;
  }
  const disconnect = state.syncing ? null : h('button.btn.btn-secondary.btn-small', { type: 'button', onclick: () => void disconnectDevice() }, 'Disconnect');
  if (d.status === 'probing') {
    replace(sections.device, head, h('p.muted', 'Talking to the Draftling...'));
    return;
  }
  if (d.status === 'silent') {
    replace(sections.device, head,
      flash('error', d.error ?? 'The Draftling does not answer.'),
      howto,
      h('div.toolbar', h('button.btn', { type: 'button', onclick: () => void probe() }, 'Try again'), disconnect),
      transferLog());
    return;
  }
  const c = d.config;
  replace(sections.device, head,
    h('p', h('span.badge.badge-ok', 'connected'), ' ',
      c && c.repoUrl ? `Set up for ${c.repoUrl} (branch ${c.branch}${c.path ? `, folder ${c.path}` : ''}).` : 'Not set up for Git synchronization yet.',
      ' ', disconnect));
}

async function connect(baud: number): Promise<void> {
  storage.local.set('draftbridge.baud', String(baud));
  let channel: SerialChannel;
  try {
    channel = await SerialChannel.request(baud);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return; // the user closed the port picker
    state.device = { status: 'closed', error: `The serial port could not be opened: ${message(err)}`, channel: null!, client: null!, configText: null, config: null };
    renderDevice();
    return;
  }
  state.kermitLog = [...channel.signalLog];
  const client = new KermitClient(channel, {
    timeoutMs: KERMIT_TIMEOUT_MS,
    retries: KERMIT_RETRIES,
    log: (line) => {
      state.kermitLog.push(line);
      if (state.kermitLog.length > 200) state.kermitLog.shift();
    },
  });
  state.device = { channel, client, status: 'probing', configText: null, config: null, error: null };
  channel.onClose = () => {
    if (state.device?.channel === channel) {
      state.device.status = 'closed';
      state.device.error = state.syncing ? null : 'The Draftling was disconnected.';
      renderAll();
    }
  };
  await probe();
}

async function probe(): Promise<void> {
  const d = state.device;
  if (!d) return;
  d.status = 'probing';
  renderAll();
  try {
    // Answer quickly when "Sync via browser" is not started.
    d.client.setTimeouts(1500, 2);
    try {
      await d.client.resetDirectory();
    } finally {
      d.client.setTimeouts(KERMIT_TIMEOUT_MS, KERMIT_RETRIES);
    }
    d.configText = await new DeviceRepo(d.client).readConfig();
    d.config = d.configText === null ? null : parseGitConfig(d.configText);
    d.status = 'ready';
    d.error = null;
    setDefaults();
  } catch (err) {
    if ((d.status as DeviceState['status']) === 'closed') return; // unplugged meanwhile
    d.status = 'silent';
    d.error = `The Draftling does not answer (${message(err)}). Is "Sync via browser" started on the device?`;
  }
  renderAll();
}

async function disconnectDevice(): Promise<void> {
  const d = state.device;
  state.device = null;
  if (d) await d.channel.close();
  renderAll();
}

// ---- 3. synchronize -------------------------------------------------------

function sameRepoAsDevice(): boolean {
  const c = state.device?.config;
  return !!(c && state.selected && sameRepo(c.repoUrl, state.selected.cloneUrl));
}

// Branch and folder: from git.cfg when the device already uses this
// repository, otherwise the repository's default branch and its root.
function setDefaults(): void {
  if (!state.selected) return;
  const c = state.device?.config;
  if (c && sameRepoAsDevice()) {
    state.branch = c.branch;
    state.path = c.path;
  } else {
    state.branch = state.selected.defaultBranch;
    state.path = '';
  }
}

function renderSync(): void {
  const s = state;
  const head = h('div.pagehead', h('h2', '3. Synchronize'));
  const ready = s.selected && s.check.status === 'ok' && s.device?.status === 'ready';
  if (!ready) {
    replace(sections.sync, head, h('p.muted', 'Choose a repository and connect the Draftling first.'));
    return;
  }
  const c = s.device!.config;
  const switching = c && c.repoUrl && !sameRepoAsDevice();
  const branch = h('input', { type: 'text', value: s.branch, disabled: s.syncing, 'aria-label': 'Branch' }) as HTMLInputElement;
  const path = h('input', { type: 'text', value: s.path, placeholder: '(whole repository)', disabled: s.syncing, 'aria-label': 'Folder' }) as HTMLInputElement;
  branch.addEventListener('input', () => { s.branch = branch.value.trim(); });
  path.addEventListener('input', () => { s.path = path.value.trim(); });
  replace(sections.sync, head,
    switching ? h('div.warning',
      h('p', `The Draftling is set up for another repository (${c.repoUrl}). Synchronizing with ${s.selected!.fullName} switches it over:`),
      h('ul',
        h('li', 'its documents are combined with the documents in the new repository (nothing is deleted),'),
        h('li', 'the history of the old repository is not copied over,'),
        h('li', 'the access token for WiFi sync in git.cfg is removed, since it belongs to the old repository.'))) : null,
    h('details.advanced', h('summary', 'Branch and folder'),
      h('div.row',
        h('label', 'Branch', branch),
        h('label', 'Folder in the repository', path)),
      h('p.muted.small', 'The Draftling\'s documents are kept in this folder of the repository; leave it empty for the top level. Other folders are not touched.')),
    h('div.toolbar',
      h('button.btn', { type: 'button', disabled: s.syncing, onclick: () => void runSync() }, s.syncing ? 'Synchronizing...' : 'Synchronize'),
      s.syncing ? h('span.muted', 'Keep this page open and the cable connected.') : null),
    progressView(),
    resultView());
}

function progressView(): HTMLElement | null {
  const s = state;
  if (!s.progress.length) return null;
  return h('div.progress',
    h('ol.steps', s.progress.map((p, i) => h('li' + (i === s.progress.length - 1 && s.syncing ? '.current' : ''), p))),
    transferLog());
}

function transferLog(): HTMLElement | null {
  const log = state.kermitLog;
  return log.length ? h('details.small', h('summary', 'Transfer details'), h('pre', log.slice(-50).join('\n'))) : null;
}

function resultView(): HTMLElement | null {
  const s = state;
  if (s.unsupported.length) {
    return h('div.flash.flash-error',
      h('p', h('strong', 'Nothing was synchronized.'), ' The repository contains files Draftling cannot handle:'),
      h('ul.mono.small', s.unsupported.slice(0, 30).map((f) => h('li', f))));
  }
  if (s.syncError) return flash('error', s.syncError);
  const r = s.result;
  if (!r) return null;
  return h('div.stack',
    flash(r.conflicts.length ? 'error' : 'ok', summarize(r)),
    r.conflicts.length ? h('div.warning',
      h('p', 'These documents were changed both on the Draftling and in the repository in the same places. Both versions are in the file, between <<<<<<< and >>>>>>> lines. Edit the file to keep what you want and synchronize again:'),
      h('ul.mono', r.conflicts.map((f) => h('li', f)))) : null,
    r.filesWritten.length || r.filesDeleted.length ? h('p.small',
      r.filesWritten.length ? `Updated on the Draftling: ${r.filesWritten.join(', ')}. ` : '',
      r.filesDeleted.length ? `Removed from the Draftling: ${r.filesDeleted.join(', ')}.` : '') : null,
    h('p.muted', 'When you are done, press F1 on the Draftling, choose "Sync via browser" and Stop. The Draftling then shows the new files.'));
}

async function runSync(): Promise<void> {
  const s = state;
  const d = s.device;
  const repo = s.selected;
  if (!d || !repo || s.syncing) return;
  let path: string;
  try {
    path = normalizePath(s.path);
  } catch (err) {
    s.syncError = message(err);
    renderSync();
    return;
  }
  if (!validBranch(s.branch)) {
    s.syncError = `"${s.branch}" is not a valid branch name.`;
    renderSync();
    return;
  }
  s.syncing = true;
  s.progress = [];
  s.kermitLog = [...d.channel.signalLog];
  s.result = null;
  s.syncError = null;
  s.unsupported = [];
  const unload = (ev: BeforeUnloadEvent) => { ev.preventDefault(); };
  window.addEventListener('beforeunload', unload);
  renderAll();
  const progress = (m: string) => {
    s.progress.push(m);
    renderSync();
  };
  try {
    const token = await accessToken();
    const provider = s.provider!;
    const remote = new GitHttpClient(`${location.origin}/proxy/${provider.id}/git/${repo.owner}/${repo.name}.git`, {
      Authorization: basicAuth(provider.gitUser, token),
    });
    await d.client.resetDirectory();
    const device = new DeviceRepo(d.client);
    const oldText = await device.readConfig();
    const old = parseGitConfig(oldText);
    const fresh = !sameRepo(old.repoUrl, repo.cloneUrl);
    s.result = await sync({
      device,
      remote,
      branch: s.branch,
      path,
      authorName: old.authorName || s.user!.name,
      authorEmail: old.authorEmail || s.user!.email,
      freshHistory: fresh,
      progress,
      beforeDeviceUpdate: async () => {
        progress('Pointing git.cfg at the repository...');
        const text = updateGitConfig(oldText, repo.cloneUrl, s.branch, path);
        if (text !== oldText) await device.writeConfig(text);
        // The remote-tracking ref of the old repository says nothing
        // about the new one.
        if (fresh && old.repoUrl && old.branch !== s.branch) await device.deleteRef(`refs/remotes/origin/${old.branch}`);
      },
    });
    d.configText = await device.readConfig();
    d.config = d.configText === null ? null : parseGitConfig(d.configText);
    await d.client.finish().catch(() => undefined);
  } catch (err) {
    if (err instanceof UnsupportedFilesError) s.unsupported = err.files;
    else s.syncError = `Synchronization failed: ${message(err)}`;
  } finally {
    s.syncing = false;
    window.removeEventListener('beforeunload', unload);
    renderAll();
  }
}

// ---- start -----------------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderAll(): void {
  renderNav();
  renderRepo();
  renderDevice();
  renderSync();
}

async function start(): Promise<void> {
  const cb = /^\/auth\/([a-z]+)\/callback$/.exec(location.pathname);
  if (cb) {
    const error = await finishLogin(cb[1]);
    history.replaceState(null, '', '/');
    if (error) {
      renderLanding(error);
      return;
    }
  }
  state.auth = loadAuth();
  state.provider = cfg.providers.find((p) => p.id === state.auth?.provider) ?? null;
  if (!state.auth || !state.provider) {
    renderLanding(null);
    return;
  }
  state.api = hostApi(state.provider.id);
  main.replaceChildren(h('p.muted', 'Loading...'));
  try {
    state.user = await state.api.user();
  } catch (err) {
    logout();
    renderLanding(`Please log in again (${message(err)}).`);
    return;
  }
  renderApp();
  await loadRepos();
}

void start();
