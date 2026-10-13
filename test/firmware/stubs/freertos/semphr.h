#pragma once
#include "freertos/FreeRTOS.h"
#include <time.h>
#include <errno.h>
static inline SemaphoreHandle_t xSemaphoreCreateBinary(void) { sem_t *s = malloc(sizeof(sem_t)); sem_init(s, 0, 0); return s; }
static inline int xSemaphoreTake(SemaphoreHandle_t s, int ms) {
  struct timespec t; clock_gettime(CLOCK_REALTIME, &t); t.tv_sec += ms / 1000; t.tv_nsec += (ms % 1000) * 1000000L;
  if (t.tv_nsec >= 1000000000L) { t.tv_sec++; t.tv_nsec -= 1000000000L; }
  return sem_timedwait(s, &t) == 0 ? pdTRUE : pdFALSE;
}
static inline int xSemaphoreGive(SemaphoreHandle_t s) { sem_post(s); return pdTRUE; }
