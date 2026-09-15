#pragma once

#include <driver/i2c_master.h>
#include <memory>

#include "bsp/board_platform.h"

class BatteryAdc;
class BoardPowerBsp;
class ChargeStatus;
class Button;
class EpdSsd1683;

// 板级单例:i2c bus / 电源 / 充电状态 / 按键 / EPD+LVGL / 电池 ADC。
// 按 Init() 内的顺序构建依赖,顺序要求详见 Init() 里的注释。
class Board {
   public:
    static Board& Get();

    void Init();

    BoardPowerBsp* power() {
        return power_.get();
    }
    ChargeStatus* charge() {
        return charge_.get();
    }
    Button* up_btn() {
        return up_btn_.get();
    }
    Button* down_btn() {
        return down_btn_.get();
    }
    Button* boot_btn() {
        return boot_btn_.get();
    }
    display::Display*           display();
    const board::BoardPlatform& platform() const;
    i2c_master_bus_handle_t i2c_bus() {
        return i2c_bus_;
    }

    // 单节锂电池电压 + 百分比。失败原因:ADC 未 ready / 没装电池(charge 状态机说)。
    bool ReadBattery(uint16_t* voltage_mv, uint8_t* percent);

   private:
    Board() = default;
    void InitPower();
    void InitI2c();
    void InitChargeStatus();
    void InitButtons();
    void InitEpd();
    void InitBatteryAdc();

    std::unique_ptr<BoardPowerBsp> power_;
    std::unique_ptr<ChargeStatus>  charge_;
    std::unique_ptr<BatteryAdc>    battery_adc_;
    std::unique_ptr<Button>        up_btn_;
    std::unique_ptr<Button>        down_btn_;
    std::unique_ptr<Button>        boot_btn_;
    std::unique_ptr<EpdSsd1683>    epd_;
    i2c_master_bus_handle_t        i2c_bus_ = nullptr;
};
