set(SOURCES
    "main.cc"

    "app/app.cc"

    "events/event_bus.cc"
    "events/ui_event_log.cc"

    "drivers/input/up_down_combo.cc"

    "power/power_state.cc"
    "power/sleep_manager.cc"

    "scenes/core/scene.cc"
    "scenes/core/scene_stack.cc"

    "startup/boot_mode.cc"
    "startup/setup_flow.cc"

    "power/shutdown.cc"
    "power/minute_boundary_ticker.cc"

    "bsp/board.cc"
    "bsp/board_platform.cc"
    "bsp/battery_adc.cc"
    "bsp/board_power.cc"
    "bsp/charge_status.cc"

    "drivers/input/button.cc"
    "drivers/bus/i2c_device.cc"
    "drivers/bus/i2c_bus_lock.cc"
    "drivers/display/epd_ssd1683.cc"
    "drivers/display/epd_ssd1683_commands.cc"
    "drivers/display/epd_ssd1683_spi.cc"
    "drivers/display/display_contract.cc"
    "drivers/display/framebuffer_ops.cc"
    "drivers/audio/audio_player.cc"

    "network/wifi.cc"
    "network/wifi_reconnect_manager.cc"
    "network/captive_portal.cc"
    "network/cred_store.cc"
    "network/sntp.cc"
    "network/dns_hijack.cc"

    "resources/captive_portal_html.cc"

    "sync/api_client.cc"
    "sync/sync_internal.cc"
    "sync/sync_service.cc"
    "sync/sync_manifest.cc"
    "sync/sync_poll.cc"

    "xiaozhi/config/activation_client.cc"
    "xiaozhi/config/settings.cc"
    "xiaozhi/mcp/mcp_dispatcher.cc"
    "xiaozhi/mcp/mcp_tools.cc"
    "xiaozhi/protocol/audio_stream_packet.cc"
    "xiaozhi/protocol/mqtt_protocol.cc"
    "xiaozhi/protocol/protocol.cc"
    "xiaozhi/protocol/websocket_protocol.cc"
    "xiaozhi/service/audio_service.cc"
    "xiaozhi/service/xiaozhi_service.cc"
    "xiaozhi/service/message_handler.cc"

    "scenes/splash/splash_scene.cc"
    "scenes/bg_refresh/bg_refresh_scene.cc"
    "scenes/xiaozhi/xiaozhi_scene.cc"
    "scenes/frame/frame_scene.cc"
    "scenes/settings/settings_scene.cc"
    "scenes/settings/settings_page_base.cc"
    "scenes/settings/settings_pages.cc"

    "ui/status_bar.cc"
    "ui/frame_view.cc"
    "ui/menu_list.cc"

    "storage/cache/cache.cc"
    "storage/cache/cache_internal.cc"
    "storage/cache/cache_paths.cc"
    "storage/cache/cache_io.cc"
    "storage/cache/cache_json.cc"
    "storage/cache/cache_state.cc"
    "storage/cache/cache_manifest.cc"
    "storage/cache/cache_frames.cc"
    "storage/cache/cache_staging.cc"
    "storage/nvs/nvs_store.cc"
    "storage/nvs/volume_store.cc"

    "resources/fonts/zfull_16.c"
    "resources/fonts/zfull_12.c"
    "resources/fonts/font_awesome_14_1.c"
    "resources/fonts/font_awesome_30_1.c"
)

set(INCLUDE_DIRS
    "."
)

set(PRIVATE_INCLUDE_DIRS
    "resources/fonts"
)

if(NOT CONFIG_SLATE_BOARD_ID STREQUAL "zectrix-note4")
    message(
        FATAL_ERROR
        "Unsupported CONFIG_SLATE_BOARD_ID='${CONFIG_SLATE_BOARD_ID}'. Only zectrix-note4 is implemented."
    )
endif()

idf_component_register(
    SRCS ${SOURCES}
    INCLUDE_DIRS ${INCLUDE_DIRS}
    PRIV_INCLUDE_DIRS ${PRIVATE_INCLUDE_DIRS}
    PRIV_REQUIRES
        78__esp-ml307
        espressif__esp_audio_codec
        espressif__esp_audio_effects
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        esp_http_server
        esp_http_client
        esp-tls
        esp_app_format
        app_update
        efuse
        mbedtls
        json
        lwip
        esp_psram
        driver
        esp_adc
        esp_lcd
        esp_timer
        esp_pm
        mqtt
        pthread
        spi_flash
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE SLATE_BOARD_ID="${CONFIG_SLATE_BOARD_ID}")
