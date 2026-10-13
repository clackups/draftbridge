How Draftbridge talks to the Draftling
=====================================

Draftbridge is a Kermit **client** for the Kermit **server** that
Draftling runs on its serial console while "Sync via browser" is
started (F1 -> Sync via browser -> Start; firmware
`components/kermit/kermit.c`, user documentation in Draftling's
`docs/sync-via-browser.md`). The browser reaches the serial port with
the Web Serial API.

Draftbridge does not need anything from the device beyond plain file
access: it runs Draftling's own Git synchronization (the steps of
`do_sync()` in `components/git_sync/git_sync.cpp`) in the browser, on
the Git repository Draftling keeps in `.git` on the SD card. The device
and WiFi sync see exactly the history they would have produced
themselves.

Link and packets
----------------

* 8 data bits, no parity, no flow control; 115200 bit/s for boards with
  a USB-to-UART chip (the speed does not matter on the ESP32-S3's
  native USB port).
* Stop-and-wait (no sliding windows). Draftbridge offers block check
  type 3 (CRC-16), repeat-count prefix `~`, long packets (up to 9024
  bytes; Draftling offers 9000), control prefix `#`, and agrees to
  8th-bit prefixing only if the server asks for it (`Y`). It does not
  offer attribute packets, so files travel byte for byte (binary).
* Commands (I, R, G) and the server's first reply use block check 1;
  replies are parsed with types 1, 3 and 2 in turn, because a server
  that is still repeating the end of its previous transfer uses the
  negotiated type.

Server functions used
---------------------

| Packet | Use |
|--------|-----|
| `I` | Before every R or G command. Draftling keeps the parameters of the last negotiation (I or S) and uses them to decode commands and to encode short replies (with repeat compression, for example), so the client sets them explicitly. |
| `R` | GET one file: working files, `git.cfg`, `.git/HEAD`, refs and loose objects. The error `File not found` means the file does not exist. |
| `S` ... `B` | SEND a batch of files: loose objects (up to 200 per batch), refs, working files, `git.cfg`. The server writes `<name>.kpart` and renames it over the target at `Z`, so a file is never half written. |
| `G C` | REMOTE CD without argument: back to the SD card root, in case another client changed the directory. |
| `G D` | REMOTE DIRECTORY: the SD card root (to find the documents), `.git/objects` (to learn which fan-out directories exist). Lines are `name size date` or `name <DIR> date`; `No files` for an empty or missing directory. |
| `G m` | REMOTE MKDIR: Draftling does not create directories when it receives a file, so Draftbridge creates `.git`, `.git/objects/xx`, `.git/refs/...` first. An existing directory gives an error, which is ignored. |
| `G E` | REMOTE DELETE: documents removed in the repository. `No files deleted` (file already gone) is not an error. |
| `G F` | FINISH at the end of a sync. Draftling acknowledges it and keeps serving until it is stopped on the device. |

Robustness
----------

* Every packet is resent on timeout, on a damaged reply and on NAK
  (a NAK for the next packet counts as an ACK).
* If the client's ACK to the server's final `B` is lost, the server
  repeats `B` while the client already sends its next command; the
  client acknowledges the stray `B` so that the server becomes idle.
* If the server's ACK to the client's final `B` is lost, the idle
  server answers the repeated `B` with an error; every file was stored
  at its `Z` already, so the client ignores it.
* Loose objects are written before the working files, and those before
  the branch ref: a sync interrupted at any point leaves a repository
  the next sync (by Draftbridge or over WiFi) repairs.

Testing against the firmware
----------------------------

`scripts/build-firmware-host.sh <draftling checkout>` compiles the
firmware's `kermit.c` with small FreeRTOS / ESP-IDF stubs
(`test/firmware/`) into a program that serves a directory over
stdin / stdout. With `DRAFTLING_KERMIT_HOST=build/kermit-host`,
`npm test` runs `test/firmware.test.ts`: the Kermit operations and
complete synchronizations against the real server code, checking the
resulting `.git` with `git fsck --strict`.

The other tests use `src/core/kermit/server.ts`, a TypeScript model of
the same server behaviour (`test/kermit.test.ts` also checks recovery
from corrupted and lost packets).
