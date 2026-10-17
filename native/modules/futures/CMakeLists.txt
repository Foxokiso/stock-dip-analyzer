# dip::futures — pure parsing/validation port of src/services/futures.js (no network, no
# clock). Its parity test also exercises dip::jsonlite, which has no driver of its own.
add_library(dip_futures src/futures.cpp)
target_include_directories(dip_futures PUBLIC include)
target_link_libraries(dip_futures PUBLIC dip_jsonlite)
dip_set_policy(dip_futures)
if(BUILD_TESTING)
  add_executable(futures_driver tests/futures_driver.cpp)
  target_link_libraries(futures_driver PRIVATE dip_futures)
  dip_set_policy(futures_driver)
  dip_add_parity_test(futures_reference_parity futures_driver verify-native-futures.mjs)
endif()
