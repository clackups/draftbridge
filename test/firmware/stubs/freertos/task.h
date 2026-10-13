#pragma once
#include "freertos/FreeRTOS.h"
typedef void *TaskHandle_t;
static inline TaskHandle_t xTaskCreateStatic(void (*fn)(void *), const char *name, uint32_t depth, void *arg, int prio, StackType_t *stack, StaticTask_t *tcb) {
  (void)name; (void)depth; (void)prio; (void)stack;
  if (pthread_create(&tcb->t, NULL, (void *(*)(void *))fn, arg) != 0) return NULL;
  return (TaskHandle_t)tcb;
}
static inline void vTaskDelete(void *t) { (void)t; pthread_exit(NULL); }
