# Pierce/27 palette shared with src/styles/tokens.css. The header is generated
# by scripts/gen-native-palette.mjs; the parity test also checks for drift.
add_library(dip_palette src/palette.cpp)
target_include_directories(dip_palette PUBLIC include)
dip_set_policy(dip_palette)
if(BUILD_TESTING)
  add_executable(palette_driver tests/palette_driver.cpp)
  target_link_libraries(palette_driver PRIVATE dip_palette)
  dip_set_policy(palette_driver)
  dip_add_parity_test(palette_reference_parity palette_driver verify-native-palette.mjs)
endif()
