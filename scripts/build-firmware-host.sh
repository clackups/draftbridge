#!/bin/sh
# Builds Draftling's Kermit server (firmware/components/kermit/kermit.c)
# as a host program that serves a directory over stdin / stdout, for
# test/firmware.test.ts:
#
#   scripts/build-firmware-host.sh ../draftling
#   DRAFTLING_KERMIT_HOST=build/kermit-host npm test
set -e
src="${1:?usage: $0 <draftling checkout>}/firmware/components/kermit"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/build"
cc -O1 -g -Wall -Wno-unused-function \
  -I"$src" -I"$src/include" -I"$here/test/firmware/stubs" \
  -o "$here/build/kermit-host" "$src/kermit.c" "$here/test/firmware/host_port.c" -lpthread
echo "built build/kermit-host"
