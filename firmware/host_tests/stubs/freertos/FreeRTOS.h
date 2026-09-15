#pragma once

struct StaticSemaphore_t {
    int unused = 0;
};

using TickType_t = unsigned int;

inline constexpr int        pdTRUE = 1;
inline constexpr TickType_t portMAX_DELAY = 0xffffffffu;

#define configASSERT(expr) ((void)(expr))
