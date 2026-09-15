#pragma once

#include "freertos/FreeRTOS.h"

using SemaphoreHandle_t = StaticSemaphore_t*;

inline SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t* buffer) {
    return buffer;
}

inline int xSemaphoreTake(SemaphoreHandle_t, TickType_t) {
    return pdTRUE;
}

inline int xSemaphoreGive(SemaphoreHandle_t) {
    return pdTRUE;
}
