cmake_minimum_required(VERSION 3.16)

project(slate_firmware_host_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(display_contract_test
    display_contract_test.cc
    ../main/drivers/display/display_contract.cc
    ../main/bsp/board_platform.cc
)

target_include_directories(display_contract_test PRIVATE ../main)

