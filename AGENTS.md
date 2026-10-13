Draftbridge
===========

Draftbridge connects a Draftling (github.com/clackups/draftling) over
its USB serial console to a Git repository, through a web browser
session. Draftling runs a Kermit file server on the console
(F1 -> "Sync via browser"); the browser talks Kermit to it over Web
Serial.

The server is stateless: it stores no user data and no session state.
Everything session-related lives in the browser's storage.

The user authenticates with GitHub or Codeberg (OAuth), then chooses
the repository for the Draftling, or creates a new one. A repository
with files whose extensions Draftling does not know is refused, and
the user is told which files. Draftling knows: md, txt, fountain.

The synchronization performs the steps Draftling's own Git sync does
over HTTP (components/git_sync/git_sync.cpp): the browser reads and
writes the device's working files and its `.git` repository over
Kermit, and makes the HTTP requests to the Git server (through the
Draftbridge server, since Git hosts do not allow cross-origin
requests).

Styling and server configuration follow Draftbox
(github.com/clackups/draftbox).

Coding rules
------------

* Only ASCII characters are allowed anywhere in the code (source
  files, comments, string literals, configuration and scripts).

* Code must stay runnable by Node's type stripping (and Bun/Deno):
  no enums, namespaces or constructor parameter properties
  (`erasableSyntaxOnly`), and relative imports use the `.ts` extension.

* Run `npm test`, `npm run typecheck` and `npm run check-ascii` before
  committing.

* The sync must keep producing what Draftling produces: the same
  commits, merge results, conflict markers and repository layout on the
  SD card. Changes to Draftling's git_sync or kermit components may
  need matching changes here.

Implementation map
------------------

* `src/core/` - runs in the browser and in Node (tests):
  * `kermit/` - packets, block checks, prefix encoding and Send-Init
    negotiation (`packet.ts`), stop-and-wait transfers (`endpoint.ts`),
    the client (`client.ts`), a model of Draftling's server for tests
    (`server.ts`), byte channels (`channel.ts`).
  * `git/` - SHA-1, zlib, objects, an object store over a pluggable
    backend (`store.ts`), history walks and sub-tree splicing
    (`history.ts`), the diff3 merge (`merge.ts`, a port of the
    firmware's git_merge.c), packfiles, pkt-lines and the smart HTTP
    client (`http.ts`).
  * `device.ts` - the SD card over Kermit: working files, `git.cfg`,
    and the loose-object repository in `.git` (the store backend).
  * `sync.ts` - one synchronization (a port of `do_sync()`), with the
    deliberate differences listed at its top.
  * `gitcfg.ts` - reading and updating `git.cfg`.
* `src/client/` - the web application: OAuth with PKCE (`auth.ts`), the
  GitHub / Forgejo REST APIs (`api.ts`), Web Serial (`serial.ts`) and
  the interface (`main.ts`). Bundled by esbuild into `static/app.js`.
* `src/server/` - Hono application: the page, OAuth token exchange and
  refresh, and the proxy to the Git host (an allow-list of REST API
  calls and the three Git smart HTTP endpoints).
* `docs/kermit.md` - how the Kermit server is used.
* `test/` - `node --test`; `helpers.ts` starts a Git smart HTTP server
  on the git binary and a simulated Draftling. `firmware.test.ts` runs
  against the firmware's kermit.c built for the host
  (`scripts/build-firmware-host.sh`).
