#include "power/shutdown.h"

#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "bsp/board.h"
#include "bsp/charge_status.h"
#include "drivers/audio/audio_player.h"
#include "sync/sync_service.h"

namespace power_shutdown {

namespace {
PreShutdownHook s_pre_shutdown_hook = nullptr;
}

void SetPreShutdownHook(PreShutdownHook hook) {
    s_pre_shutdown_hook = hook;
}

bool WaitForEpdAndShutdown(int epd_timeout_ms) {
    if (s_pre_shutdown_hook)
        s_pre_shutdown_hook();
    SyncService::Get().Stop();
    AudioPlayer::Get().Stop();
    if (auto* charge = Board::Get().charge())
        charge->StopTick();

    auto* display = Board::Get().display();
    if (!display)
        return true;

    return display->WaitForRefreshIdle(epd_timeout_ms);
}

[[noreturn]] void GracefulRestart(int pre_delay_ms, int epd_timeout_ms) {
    if (pre_delay_ms > 0)
        vTaskDelay(pdMS_TO_TICKS(pre_delay_ms));

    WaitForEpdAndShutdown(epd_timeout_ms);

    esp_restart();
    __builtin_unreachable();
}

}  // namespace power_shutdown
