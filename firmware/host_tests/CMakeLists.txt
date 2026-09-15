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

target_include_directories(display_contract_test PRIVATE ../main)
target_include_directories(cache_staging_test PRIVATE stubs ../main)
target_compile_definitions(display_contract_test PRIVATE "SLATE_BOARD_ID=\"zectrix-note4\"")
target_compile_options(display_contract_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
target_compile_options(cache_staging_test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)

enable_testing()
add_test(NAME display_contract_test COMMAND display_contract_test)
add_test(NAME cache_staging_test COMMAND cache_staging_test)
