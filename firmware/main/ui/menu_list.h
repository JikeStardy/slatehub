#pragma once

// EPD 友好的列表控件:每项一个 lv_label,光标位置用左侧黑色 bar 标记。
// items > kVisibleRows 时右侧出现一个细 thumb 标记当前视口在总长度里的位置,
// 不画 track(1bpp 灰阶有限,track + thumb 都用纯黑会糊在一起)。
//
// 当前 Note4 UI 根高度减去 status bar 后，对称 pad 12、行高 42 -> 视口 6 行。
// (12 + 6×42 + 12 = 276 完美填满,thumb track 区也自然对称)。
// 滚动一律走 partial refresh(EPD 自身按 dirty 比例自决是否升 full),
// 不主动 full,牺牲一点残影换响应速度。OnUp/OnDown 仍返回是否发生 viewport
// 平移,留给调用方扩展用。

#include <functional>
#include <string>
#include <vector>

#include <lvgl.h>

class MenuList {
   public:
    struct Item {
        std::string           title;
        std::function<void()> on_enter;  // ENTER 短按触发
    };

    static constexpr int kVisibleRows = 6;

    MenuList(lv_obj_t* parent, std::vector<Item> items, int initial_cursor = 0);

    // 返回 true 表示视口发生了滚动(调用方应走 full refresh 而非 partial)。
    bool OnUp();
    bool OnDown();
    void OnEnter();  // 触发当前项

    int Cursor() const {
        return cursor_;
    }
    lv_obj_t* root() {
        return root_;
    }

   private:
    void Redraw();
    // 调整 viewport_top_ 使 cursor_ 落在 [viewport_top_, viewport_top_ + kVisibleRows)。
    // 返回 true 表示 viewport_top_ 发生变化。
    bool EnsureCursorVisible();

    std::vector<Item>      items_;
    int                    cursor_       = 0;
    int                    viewport_top_ = 0;
    lv_obj_t*              root_         = nullptr;
    std::vector<lv_obj_t*> rows_;  // 行容器,滚动时调整 y / hidden
    std::vector<lv_obj_t*> cursor_bars_;
    // 右侧 scrollbar thumb,items > kVisibleRows 时才创建。
    // 高度 = visible/total × track_h(下界 theme::kScrollbarThumbMinH),y 跟随 viewport_top_。
    lv_obj_t* thumb_ = nullptr;
};
