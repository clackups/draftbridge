/* kport_* over stdin / stdout, and a main() that serves a directory:
 * the firmware's Kermit server on a PC, for testing Draftbridge. */
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "kermit.h"
#include "kermit_port.h"

esp_err_t kport_open(void) { return ESP_OK; }
void kport_close(void) {}
int kport_read(uint8_t *buf, size_t max, uint32_t timeout_ms) {
  struct pollfd p = { .fd = 0, .events = POLLIN };
  if (poll(&p, 1, (int)timeout_ms) <= 0) return 0;
  ssize_t n = read(0, buf, max);
  if (n <= 0) { _exit(0); }
  return (int)n;
}
void kport_write(const uint8_t *buf, size_t len) {
  while (len) { ssize_t n = write(1, buf, len); if (n <= 0) return; buf += n; len -= (size_t)n; }
}
static void cb(const char *msg, bool changed) { fprintf(stderr, "[server] %s%s\n", msg, changed ? " (changed)" : ""); }
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (kermit_server_start(argv[1], cb) != ESP_OK) return 1;
  for (;;) pause();
}
