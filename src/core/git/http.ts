// Git smart HTTP client (protocol v0, stateless RPC), the same requests
// Draftling sends over WiFi: info/refs, git-upload-pack and
// git-receive-pack. In the browser the requests go through the
// Draftbridge server, which forwards them to the Git host (Git hosts do
// not allow cross-origin requests).

import { ByteWriter, concat, latin1 } from '../bytes.ts';
import { joinPkts, pktText, readPkt } from './pktline.ts';
import { ZERO_OID } from './objects.ts';

export interface RemoteRef {
  name: string;
  oid: string;
}

export interface Advertisement {
  refs: RemoteRef[];
  capabilities: string[];
}

export class GitHttpError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GitHttpError';
    this.status = status;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<Response>;

const AGENT = 'agent=draftbridge/0.1';

export class GitHttpClient {
  // Repository URL ending in ".git", without a trailing slash.
  readonly url: string;
  private headers: Record<string, string>;
  private fetchFn: FetchLike;

  constructor(url: string, headers: Record<string, string>, fetchFn: FetchLike = (u, i) => fetch(u, i as RequestInit)) {
    this.url = url.replace(/\/+$/, '');
    this.headers = headers;
    this.fetchFn = fetchFn;
  }

  private async request(path: string, method: string, headers: Record<string, string>, body?: Uint8Array): Promise<Uint8Array> {
    const res = await this.fetchFn(this.url + path, { method, headers: { ...this.headers, ...headers }, body });
    if (res.status === 401 || res.status === 403) throw new GitHttpError('the Git server rejected the credentials', res.status);
    if (res.status === 404) throw new GitHttpError('repository not found', res.status);
    if (!res.ok) throw new GitHttpError(`Git server error: HTTP ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  async advertise(service: 'git-upload-pack' | 'git-receive-pack'): Promise<Advertisement> {
    const body = await this.request(`/info/refs?service=${service}`, 'GET', { Accept: '*/*' });
    return parseAdvertisement(body);
  }

  // Fetches a packfile with the objects of `wants` that are missing from
  // `haves`. Returns the raw packfile (null if the server sent none).
  async fetchPack(wants: string[], haves: string[], caps: string[]): Promise<Uint8Array | null> {
    const useSideband = caps.includes('side-band-64k');
    const reqCaps = ['ofs-delta', 'no-progress', AGENT];
    if (useSideband) reqCaps.unshift('side-band-64k');
    const lines: Array<string | null> = [];
    wants.forEach((w, i) => lines.push(i === 0 ? `want ${w} ${reqCaps.join(' ')}\n` : `want ${w}\n`));
    lines.push(null);
    for (const h of haves) lines.push(`have ${h}\n`);
    lines.push('done\n');
    const body = await this.request('/git-upload-pack', 'POST', {
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
    }, joinPkts(lines));
    return parseUploadPackResult(body, useSideband);
  }

  // Updates `ref` from `oldOid` (null: create) to `newOid`, sending the
  // pack. Throws with the server's reason when the update is refused.
  async push(ref: string, oldOid: string | null, newOid: string, pack: Uint8Array): Promise<void> {
    const cmd = `${oldOid ?? ZERO_OID} ${newOid} ${ref}\0report-status ${AGENT}\n`;
    const body = concat([joinPkts([cmd, null]), pack]);
    const res = await this.request('/git-receive-pack', 'POST', {
      'Content-Type': 'application/x-git-receive-pack-request',
      Accept: 'application/x-git-receive-pack-result',
    }, body);
    const lines: string[] = [];
    let pos = 0;
    while (pos < res.length) {
      const p = readPkt(res, pos);
      pos = p.end;
      if (p.data) lines.push(pktText(p.data));
    }
    const unpack = lines.find((l) => l.startsWith('unpack '));
    if (unpack && unpack !== 'unpack ok') throw new GitHttpError(`push failed: ${unpack}`);
    const ng = lines.find((l) => l.startsWith(`ng ${ref}`));
    if (ng) throw new GitHttpError(`push refused: ${ng.slice(4 + ref.length).trim() || 'rejected'}`);
    if (!lines.some((l) => l === `ok ${ref}`)) throw new GitHttpError('push failed: no confirmation from the server');
  }
}

export function parseAdvertisement(body: Uint8Array): Advertisement {
  const refs: RemoteRef[] = [];
  let capabilities: string[] = [];
  let pos = 0;
  let first = true;
  while (pos < body.length) {
    const p = readPkt(body, pos);
    pos = p.end;
    if (!p.data) continue;
    let line = pktText(p.data);
    if (line.startsWith('# service=')) continue;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (first) capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    first = false;
    const [oid, name] = line.split(' ');
    if (!name || name === 'capabilities^{}' || name.endsWith('^{}')) continue;
    refs.push({ name, oid });
  }
  return { refs, capabilities };
}

function parseUploadPackResult(body: Uint8Array, sideband: boolean): Uint8Array | null {
  let pos = 0;
  // Acknowledgement lines (NAK / ACK) come first.
  while (pos < body.length) {
    if (latin1(body.subarray(pos, pos + 4)) === 'PACK') return body.subarray(pos);
    const p = readPkt(body, pos);
    if (!p.data) { pos = p.end; continue; }
    const text = pktText(p.data);
    if (text === 'NAK' || text.startsWith('ACK ')) { pos = p.end; continue; }
    if (text.startsWith('ERR ')) throw new GitHttpError(`fetch failed: ${text.slice(4)}`);
    break;
  }
  if (pos >= body.length) return null;
  if (!sideband) return body.subarray(pos);
  const out = new ByteWriter();
  while (pos < body.length) {
    const p = readPkt(body, pos);
    pos = p.end;
    if (!p.data || p.data.length === 0) continue;
    const band = p.data[0];
    if (band === 1) out.bytes(p.data.subarray(1));
    else if (band === 3) throw new GitHttpError(`fetch failed: ${pktText(p.data.subarray(1))}`);
  }
  return out.length ? out.result() : null;
}

export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}
