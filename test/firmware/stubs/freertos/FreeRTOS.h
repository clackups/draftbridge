#pragma once
#include <stdint.h>
#include <pthread.h>
#include <semaphore.h>
typedef uint8_t StackType_t;
typedef struct { pthread_t t; } StaticTask_t;
typedef sem_t *SemaphoreHandle_t;
typedef int BaseType_t;
#define pdTRUE 1
#define pdFALSE 0
#define pdMS_TO_TICKS(ms) (ms)
