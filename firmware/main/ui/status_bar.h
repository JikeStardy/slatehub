#pragma once

// 顶部 24px 小状态栏：左 WiFi 图标 / 中标题 / 右电量图标。
// 不持有刷屏策略，只 set_text；调用方（FrameScene）决定何时调
// display::RequestRefreshWithFallback()。

#include <lvgl.h>

#include <string>

class StatusBar {
   public:
    explicit StatusBar(lv_obj_t* parent);

    // 返回 true 表示有任何字段实际变化（调用方据此决定是否刷屏）。
    bool SetWifi(bool connected, int rssi);
    // charging / full 互斥(ChargeStatus 保证):
    //   full=true     → 满电图标 + "100%"(物理充满,不再走 ADC 估算)
    //   charging=true → BOLT 图标 + "--"(ADC 端电压被充电 IC 拉高,pct 不可信)
    //   都 false      → 按 pct 显示真实电量
    bool SetBattery(int pct, bool charging, bool full);
    bool SetCaption(const std::string& text);
    bool SetCaptionIcon(const char* icon);

    void Show();
    void Hide();

   private:
    void LayoutTitle();

    lv_obj_t* root_             = nullptr;
    lv_obj_t* wifi_label_       = nullptr;
    lv_obj_t* battery_label_    = nullptr;
    lv_obj_t* battery_pct_lbl_  = nullptr;  // 电池图标左侧的百分比文字
    lv_obj_t* title_icon_label_ = nullptr;
    lv_obj_t* title_label_      = nullptr;

    std::string shown_wifi_;
    std::string shown_battery_;
    // 直接缓存最终文本(可能为空,空 = 充电中只剩图标),避免再用 sentinel int 区分
    // "未知"/"隐藏"/"具体百分比"。
    std::string shown_pct_text_;
    std::string shown_title_icon_;
    std::string shown_title_;
};
