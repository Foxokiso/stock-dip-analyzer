cmake_minimum_required(VERSION 3.20)
project(DipAnalyzerNativeCore VERSION 0.1.0 LANGUAGES CXX)

# Shared compiler policy for every native module.
function(dip_set_policy target)
  target_compile_features(${target} PUBLIC cxx_std_20)
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /WX /utf-8)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Werror -pedantic)
  endif()
endfunction()

include(CTest)
if(BUILD_TESTING)
  find_program(NODE_EXECUTABLE node REQUIRED)
endif()
set(DIP_SCRIPTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../scripts")

# Registers a cross-language parity test: a native line-protocol driver is
# spawned by a Node verifier that compares it against the JavaScript reference.
function(dip_add_parity_test name driver_target verifier_script)
  if(BUILD_TESTING)
    add_test(NAME ${name}
      COMMAND "${NODE_EXECUTABLE}" "${DIP_SCRIPTS_DIR}/${verifier_script}" "$<TARGET_FILE:${driver_target}>"
      WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/..")
  endif()
endfunction()

# Numerical scoring core (first module).
add_library(dip_analysis src/analysis.cpp)
target_include_directories(dip_analysis PUBLIC include)
dip_set_policy(dip_analysis)
if(BUILD_TESTING)
  add_executable(analysis_driver tests/analysis_driver.cpp)
  target_link_libraries(analysis_driver PRIVATE dip_analysis)
  dip_set_policy(analysis_driver)
  dip_add_parity_test(scoring_reference_parity analysis_driver verify-native-analysis.mjs)
endif()

# Every further module lives in native/modules/<name>/ with its own
# CMakeLists.txt, headers under include/dip/, and a parity driver under tests/.
file(GLOB DIP_MODULE_DIRS LIST_DIRECTORIES true "${CMAKE_CURRENT_SOURCE_DIR}/modules/*")
foreach(module_dir ${DIP_MODULE_DIRS})
  if(EXISTS "${module_dir}/CMakeLists.txt")
    add_subdirectory("${module_dir}")
  endif()
endforeach()
