cmake_minimum_required(VERSION 3.16)

project(slate_firmware_host_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(display_contract_test
    display_contract_test.cc
    ../main/drivers/display/display_contract.cc
    ../main/bsp/board_platform.cc
    ../main/sync/manifest_contract.cc
)

add_executable(cache_staging_test
    cache_staging_test.cc
    ../main/storage/cache/cache_staging.cc
)

add_executable(cache_integration_test
    cache_integration_test.cc
    stubs/cJSON.cc
    ../main/drivers/display/display_contract.cc
    ../main/storage/cache/cache.cc
    ../main/storage/cache/cache_frames.cc
    ../main/storage/cache/cache_internal.cc
    ../main/storage/cache/cache_io.cc
    ../main/storage/cache/cache_json.cc
    ../main/storage/cache/cache_manifest.cc
    ../main/storage/cache/cache_paths.cc
    ../main/storage/cache/cache_staging.cc
    ../main/storage/cache/cache_state.cc
    ../main/sync/manifest_contract.cc
)

add_executable(sync_current_content_transaction_test
    sync_current_content_transaction_test.cc
    stubs/cJSON.cc
    ../main/drivers/display/display_contract.cc
    ../main/storage/cache/cache_frames.cc
    ../main/storage/cache/cache_internal.cc
    ../main/storage/cache/cache_io.cc
    ../main/storage/cache/cache_json.cc
    ../main/storage/cache/cache_manifest.cc
    ../main/storage/cache/cache_paths.cc
    ../main/storage/cache/cache_staging.cc
    ../main/storage/cache/cache_state.cc
    ../main/sync/manifest_contract.cc
    ../main/sync/sync_internal.cc
    ../main/sync/sync_manifest.cc
)

add_executable(firmware_update_contract_test
    firmware_update_contract_test.cc
    stubs/cJSON.cc
    ../main/update/firmware_offer.cc
)

target_include_directories(display_contract_test PRIVATE ../main)
target_include_directories(cache_staging_test PRIVATE stubs ../main)
target_include_directories(cache_integration_test PRIVATE stubs ../main)
target_include_directories(sync_current_content_transaction_test PRIVATE stubs ../main)
target_include_directories(firmware_update_contract_test PRIVATE stubs ../main)
target_compile_definitions(display_contract_test PRIVATE "SLATE_BOARD_ID=\"zectrix-note4\"")
target_compile_definitions(cache_staging_test PRIVATE SLATE_HOST_TEST)
target_compile_definitions(cache_integration_test PRIVATE SLATE_HOST_TEST "SLATE_BOARD_ID=\"zectrix-note4\"")
target_compile_definitions(sync_current_content_transaction_test PRIVATE SLATE_HOST_TEST "SLATE_BOARD_ID=\"zectrix-note4\"")
target_compile_definitions(firmware_update_contract_test PRIVATE SLATE_HOST_TEST "SLATE_BOARD_ID=\"zectrix-note4\"")
target_compile_options(display_contract_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_compile_options(cache_staging_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_compile_options(cache_integration_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_compile_options(sync_current_content_transaction_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_compile_options(firmware_update_contract_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)

enable_testing()
add_test(NAME display_contract_test COMMAND display_contract_test)
add_test(NAME cache_staging_test COMMAND cache_staging_test)
add_test(NAME cache_integration_test COMMAND cache_integration_test)
add_test(NAME sync_current_content_transaction_test COMMAND sync_current_content_transaction_test)
add_test(NAME firmware_update_contract_test COMMAND firmware_update_contract_test)
