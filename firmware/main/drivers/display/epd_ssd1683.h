#pragma once

#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lvgl.h>

#include <atomic>
#include <functional>
#include <vector>

#include "drivers/display/display_contract.h"
#include "drivers/display/framebuffer_ops.h"

// SSD1683 类驱动 4.2" 黑白 EPD（400×300，1bpp）+ LVGL 集成。
// SPI 写帧 + 异步 refresh_task（300 ms 节流，防过频刷新损伤 EPD）+ LVGL flush_cb
// 阈值化 RGB565→1bpp。RequestUrgentFullRefresh() 立即触发全帧刷新。
class EpdSsd1683 : public display::Display {
   public:
    static constexpr int kWidth     = 400;
    static constexpr int kHeight    = 300;
    static constexpr int kBufferLen = ((kWidth + 7) / 8) * kHeight;

    EpdSsd1683();
    ~EpdSsd1683() override;
    EpdSsd1683(const EpdSsd1683&) = delete;
    EpdSsd1683& operator=(const EpdSsd1683&) = delete;
    EpdSsd1683(EpdSsd1683&&) = delete;
    EpdSsd1683& operator=(EpdSsd1683&&) = delete;

    void Init();

    const display::DisplayInfo& Info() const override;

    bool IsRefreshPending();
    // 阻塞轮询直到刷新结束或超时。返回 true=已空闲，false=超时仍 pending。
    // 进深睡 / 关 rail / 后台刷新结束前用它确保不在刷新中途切断 EPD 电源。
    bool WaitForRefreshIdle(int timeout_ms) override;
    void RequestRefresh(display::PresentMode mode) override;
    void RequestUrgentPartialRefresh();  // partial(~1s 残影)
    void RequestUrgentFullRefresh();     // full(~5s 干净)

    // 直接把 1bpp 原始数据写入 framebuffer，绕过 LVGL 管线。
    // bit=1=白，bit=0=黑（与服务端下发格式一致，无需反转）。
    // 调用后自动 notify refresh_task；调用方再发 RequestUrgentXxxRefresh 设 urgent 标志。
    void WriteRaw1bpp(int x, int y, int w, int h, const uint8_t* data, size_t len);
    bool Present(const display::FrameRegion& region, const uint8_t* data, size_t len,
                 display::PresentMode mode) override;

    // 把已知的当前物理画面种到 buffer_/prev_snapshot_，不触发刷新。
    // deep sleep 唤醒后内存丢失，但 EPD 物理像素仍保持；timer 自动刷新要先用
    // 睡前缓存重建 previous snapshot，后续才能做真正 partial 而不是首次 full 清屏。
    void SeedPreviousRaw1bpp(int x, int y, int w, int h, const uint8_t* data, size_t len);
    bool SeedPrevious(const display::FrameRegion& region, const uint8_t* data, size_t len) override;

    // 读取上次已刷到物理屏的 framebuffer 快照。只有 prev_snapshot_ 已同步时返回 true。
    bool ReadPreviousRaw1bpp(int x, int y, int w, int h, uint8_t* out, size_t len);
    bool ReadPrevious(const display::FrameRegion& region, uint8_t* out, size_t len) override;

    bool Lock(int timeout_ms = 0) override;
    void Unlock() override;

    lv_display_t* lvgl_display() {
        return lvgl_display_;
    }

   private:
    spi_device_handle_t spi_        = nullptr;
    bool                spi_inited_ = false;

    uint8_t*             buffer_          = nullptr;  // 实时 framebuffer（LVGL flush 写入）
    uint8_t*             snapshot_        = nullptr;  // refresh_task 冻结的本轮快照
    uint8_t*             prev_snapshot_   = nullptr;  // 上次已刷到 EPD 的快照
    uint8_t*             lvgl_render_buf_ = nullptr;
    std::vector<uint8_t> epd_line_;

    // 200 而非 128：LVGL anti-alias 字体边缘的灰度像素被划入「黑」，
    // 字体看起来粗实清晰。128 中性二值化会让灰边判白丢失,字体发虚。
    static constexpr uint8_t kBwThreshold = 200;

    lv_display_t* lvgl_display_ = nullptr;
    static void   LvglFlushCb(lv_display_t* disp, const lv_area_t* area, uint8_t* color_p);

    SemaphoreHandle_t    dirty_mutex_  = nullptr;
    TaskHandle_t         refresh_task_ = nullptr;
    SemaphoreHandle_t    refresh_exit_ = nullptr;
    epd::Rect            dirty_;
    bool                 pending_                  = false;
    bool                 urgent_refresh_           = false;
    bool                 force_full_refresh_       = false;
    bool                 refresh_task_stop_        = false;
    bool                 prev_snapshot_synced_     = false;
    bool                 refresh_in_progress_      = false;
    TickType_t           last_sample_tick_         = 0;
    TickType_t           last_flush_tick_          = 0;  // LVGL 最后一次 flush_cb 的时刻,用于等待静默
    int                  sample_interval_ms_       = 300;
    int                  partial_since_full_       = 0;  // 累积多少次 partial 后强制 full 清残影
    static constexpr int kPartialBeforeFullCleanup = 8;

    void        StartRefreshTask();
    static void RefreshTaskEntry(void* arg);
    void        RefreshTaskLoop();
    bool        RefreshTaskShouldStop();
    void        DebounceRefreshNotify();
    bool        TakeRefreshRequest(bool& urgent, bool& force_full);
    bool        ThrottleRefreshSampling(bool urgent, bool force_full);
    bool        CaptureRefreshSnapshot(bool force_full, epd::DiffResult& diff, bool& prev_synced);
    bool        ShouldUseFullRefresh(const epd::DiffResult& diff, bool force_full, bool prev_synced) const;
    void        RunRefresh(bool full_refresh);
    void        FinishRefreshSnapshot();
    void        MarkRefreshIdle();

    void AssertRefreshTaskContext() const;
    void SpiPortInit();    // 发送模式（DI 当 MOSI，40 MHz）
    void SpiPortRxInit();  // 接收模式（DI 反向当 MISO，8 MHz）—— 读温度寄存器
    void SpiGpioInit();
    void EpdInit();
    void EpdDisplayFull();
    void EpdDisplayPartial();
    void EpdTurnOnDisplay();
    // 读屏内温度寄存器(0x40)→映射 5 档 booster 写 0xE0/0xE6,Full/Partial 共用。
    // 60 s 内重复刷新会复用上次温度避免每次 5~10 ms 切换 SPI 模式开销。
    void    ApplyTemperatureBoost();
    int64_t last_temp_read_ms_ = 0;
    uint8_t cached_booster_    = 0;
    void    EpdSendCommand(uint8_t c);
    void    EpdSendData(uint8_t d);
    uint8_t EpdRecvData();  // refresh_task only:切到 RX 模式读 1 字节,读完切回 TX
    void    WriteBytes(const uint8_t* buf, int len);
    void    ReadBusy();
    void    EpdPowerOn();  // 主动管 EPD_PWR_PIN(含 hold_dis/set/hold_en)
    void    EpdPowerOff();

    // pin 缓存（来自 bsp/config.h）
    gpio_num_t        cs_, dc_, rst_, busy_, mosi_, sclk_;
    spi_host_device_t spi_host_;
};
