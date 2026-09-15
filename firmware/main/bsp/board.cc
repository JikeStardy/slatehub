#include "bsp/board.h"

#include <driver/rtc_io.h>
#include <esp_log.h>
#include <esp_sleep.h>

#include <sdkconfig.h>

#include "bsp/battery_adc.h"
#include "bsp/board_power.h"
#include "bsp/charge_status.h"
#include "bsp/config.h"
#include "drivers/bus/i2c_bus_lock.h"
#include "drivers/display/epd_ssd1683.h"
#include "drivers/input/button.h"
#include "utils/time_utils.h"

namespace {
constexpr char     kTag[]          = "board";
constexpr uint16_t kNavLongPressMs = 1000;

// deep sleep 唤醒(非 cold boot)后，睡前用 rtc_gpio_hold_en 锁住的 EXT1 唤醒源
// (GPIO0/18/2)仍处于 RTC IO + hold 态。显式释放并交还数字 IO 矩阵，iot_button /
// charge_status 才能正常驱动这些脚。原先隐式依赖 ESP_SLEEP_GPIO_RESET_WORKAROUND，
// 这里与睡眠侧(sleep_manager.cc::PrepareWakeupGpio)对称地显式释放。
// VBAT_PWR(GPIO17) 不在此释放：它是供电自锁，断电窗口=变砖，交由 board_power 的
// VbatPowerOn 接管(先驱动高再切域)。
void ReleaseDeepSleepWakeHolds() {
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED)
        return;  // cold boot：无遗留 hold
    ESP_LOGD(kTag, "wake hold release");
    const gpio_num_t pins[] = {
        static_cast<gpio_num_t>(BOOT_BUTTON_GPIO),
        static_cast<gpio_num_t>(DOWN_BUTTON_GPIO),
        static_cast<gpio_num_t>(CHARGE_DETECT_GPIO),
    };
    for (gpio_num_t pin : pins) {
        ESP_LOGD(kTag, "wake hold release pin=%d", static_cast<int>(pin));
        rtc_gpio_hold_dis(pin);
        rtc_gpio_deinit(pin);
    }
}
}  // namespace

Board& Board::Get() {
    static Board s;
    return s;
}

void Board::Init() {
    ESP_LOGD(kTag, "init begin");
    ReleaseDeepSleepWakeHolds();
    InitPower();
    InitI2c();
    InitChargeStatus();
    // 阶段 1：屏保取消，绿 LED 不再随充电状态闪烁。InitLed 只把 GPIO3 配 OUTPUT
    // 并熄灭，避免 strapping pin 浮空。状态指示交给 StatusBar。
    power_->InitLed();
    InitEpd();
    InitButtons();
    InitBatteryAdc();
    ESP_LOGD(kTag, "init done");
}

void Board::InitPower() {
    ESP_LOGD(kTag, "init power begin");
    charge_ = std::make_unique<ChargeStatus>();
    // BoardPowerBsp 一次 gpio_config 把 audio rail / PA CTRL / VBAT 三个 pin 都
    // 配 OUTPUT,PA CTRL(GPIO46) 在构造完成的瞬间被驱动 LOW。后面 PowerAudioOn
    // 给 PA U5 通电时,CTRL 已稳定 LOW → 消除开机"啵"声(详见 board_power.cc)。
    // EPD_PWR(GPIO6) 由 EpdSsd1683 自管。
    power_ = std::make_unique<BoardPowerBsp>(AUDIO_PWR_PIN, AUDIO_CODEC_PA_PIN, VBAT_PWR_PIN);
    power_->VbatPowerOn();   // GPIO17=1,自锁电源
    power_->PowerAudioOn();  // GPIO42=1,AVDD_3V3 起来,I²C 上拉才有效

    // 等用户松开下键(SW1=GPIO18)。开机时硬件靠 SW1 把 Q5 栅极拉低维持电源,
    // VbatPowerOn 之后软件接管；但按键驱动一启动就会读到下键的「已按」状态而误触
    // 一次回调,所以 busy-wait 等用户先松开。
    // 2s 超时是兜底:理论上电源故障跑不到这,但加上避免硬件诡异时永久挂死。
    constexpr int kMaxWaitMs = 2000;
    int           waited     = 0;
    while (!gpio_get_level(static_cast<gpio_num_t>(POWER_KEY_GPIO))) {
        vTaskDelay(pdMS_TO_TICKS(10));
        waited += 10;
        if (waited >= kMaxWaitMs) {
            ESP_LOGW(kTag, "power key wait timeout waited_ms=%d", waited);
            break;
        }
    }
    ESP_LOGD(kTag, "init power done down_key_wait_ms=%d", waited);
}

void Board::InitI2c() {
    ESP_LOGD(kTag, "init i2c");
    ScopedI2cBusLock lock("Board::InitI2c");
    ESP_ERROR_CHECK(lock.status());
    i2c_master_bus_config_t cfg      = {};
    cfg.i2c_port                     = I2C_NUM_0;
    cfg.sda_io_num                   = AUDIO_CODEC_I2C_SDA_PIN;
    cfg.scl_io_num                   = AUDIO_CODEC_I2C_SCL_PIN;
    cfg.clk_source                   = I2C_CLK_SRC_DEFAULT;
    cfg.glitch_ignore_cnt            = 7;
    cfg.intr_priority                = 0;
    cfg.trans_queue_depth            = 0;
    cfg.flags.enable_internal_pullup = 1;
    ESP_ERROR_CHECK(i2c_new_master_bus(&cfg, &i2c_bus_));
}

void Board::InitChargeStatus() {
    ESP_LOGD(kTag, "init charge status");
    charge_->Init(static_cast<gpio_num_t>(CHARGE_DETECT_GPIO), static_cast<gpio_num_t>(CHARGE_FULL_GPIO),
                  time_utils::NowMs());
    charge_->StartTick();
}

void Board::InitEpd() {
    ESP_LOGD(kTag, "init epd");
    epd_ = std::make_unique<EpdSsd1683>();
    epd_->Init();
}

void Board::InitButtons() {
    ESP_LOGD(kTag, "init buttons up=%d down=%d enter=%d long_ms=%u", static_cast<int>(UP_BUTTON_GPIO),
             static_cast<int>(DOWN_BUTTON_GPIO), static_cast<int>(BOOT_BUTTON_GPIO),
             static_cast<unsigned>(kNavLongPressMs));
    // 三个业务按键统一 1s 长按阈值。具体语义由当前 Scene 处理:
    // FrameScene 中 UP/DOWN 长按切内容组,ENTER 长按进设置;危险动作在各确认页长按执行。
    // 不启用 iot_button 的 enable_power_save：它会注册一个 GPIO wake ISR，
    // flash cache 关闭期间（例如 LittleFS rename）触发会因 ISR 不在 IRAM 崩溃。
    // Deep sleep 唤醒由 SleepManager 进入睡眠前单独配置 EXT1。
    up_btn_   = std::make_unique<Button>(static_cast<gpio_num_t>(UP_BUTTON_GPIO), false, kNavLongPressMs, 0);
    down_btn_ = std::make_unique<Button>(static_cast<gpio_num_t>(DOWN_BUTTON_GPIO), false, kNavLongPressMs, 0);
    boot_btn_ = std::make_unique<Button>(static_cast<gpio_num_t>(BOOT_BUTTON_GPIO), false, kNavLongPressMs, 0);
}

void Board::InitBatteryAdc() {
    ESP_LOGD(kTag, "init battery adc");
    battery_adc_ = std::make_unique<BatteryAdc>();
    battery_adc_->Init();
}

display::Display* Board::display() {
    return epd_.get();
}

const board::BoardPlatform& Board::platform() const {
    return board::CurrentPlatform();
}

bool Board::ReadBattery(uint16_t* voltage_mv, uint8_t* percent) {
    if (!battery_adc_)
        return false;

    // 先看充电状态机:无电池时电压采样不可信,直接返失败。
    if (charge_ && charge_->Get().no_battery) {
        return false;
    }

    return battery_adc_->Read(voltage_mv, percent);
}
