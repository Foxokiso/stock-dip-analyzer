cmake_minimum_required(VERSION 3.20)
project(DipAnalyzerNativeCore VERSION 0.0.0 LANGUAGES CXX)

add_library(dip_analysis src/analysis.cpp)
target_include_directories(dip_analysis PUBLIC include)
target_compile_features(dip_analysis PUBLIC cxx_std_20)
set_target_properties(dip_analysis PROPERTIES CXX_EXTENSIONS OFF)
if(MSVC)
  target_compile_options(dip_analysis PRIVATE /W4 /WX)
else()
  target_compile_options(dip_analysis PRIVATE -Wall -Wextra -Werror -pedantic)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(analysis_driver tests/analysis_driver.cpp)
  target_link_libraries(analysis_driver PRIVATE dip_analysis)
  find_program(NODE_EXECUTABLE node REQUIRED)
  add_test(NAME scoring_reference_parity
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/verify-native-analysis.mjs"
      "$<TARGET_FILE:analysis_driver>")
endif()
