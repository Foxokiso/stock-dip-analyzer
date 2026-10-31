# dip::marketdata — Yahoo chart/quote normalization ported from src/utils/marketData.js.
add_library(dip_marketdata src/marketdata.cpp)
target_include_directories(dip_marketdata PUBLIC include)
dip_set_policy(dip_marketdata)
if(BUILD_TESTING)
  add_executable(marketdata_driver tests/marketdata_driver.cpp)
  target_link_libraries(marketdata_driver PRIVATE dip_marketdata)
  dip_set_policy(marketdata_driver)
  dip_add_parity_test(marketdata_reference_parity marketdata_driver verify-native-marketdata.mjs)
  # The verifier repeats the case-insensitive zone lookups under a Turkish LC_CTYPE, where
  # std::tolower leaves 'I' unfolded. Linux CI images install no Turkish locale, so where
  # glibc's locale sources are present one is compiled into the build tree for that run
  # (the verifier sets LOCPATH for it alone; elsewhere it uses an installed locale or skips).
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_program(LOCALEDEF_EXECUTABLE localedef)
    set(DIP_TURKISH_LOCALE_DIR "${CMAKE_BINARY_DIR}/locales")
    if(LOCALEDEF_EXECUTABLE AND NOT EXISTS "${DIP_TURKISH_LOCALE_DIR}/tr_TR.UTF-8/LC_CTYPE")
      file(MAKE_DIRECTORY "${DIP_TURKISH_LOCALE_DIR}")
      execute_process(COMMAND "${LOCALEDEF_EXECUTABLE}" -c -i tr_TR -f UTF-8 "${DIP_TURKISH_LOCALE_DIR}/tr_TR.UTF-8"
        OUTPUT_QUIET ERROR_QUIET)
    endif()
    if(EXISTS "${DIP_TURKISH_LOCALE_DIR}/tr_TR.UTF-8/LC_CTYPE")
      set_tests_properties(marketdata_reference_parity PROPERTIES ENVIRONMENT "DIP_LOCALE_DIR=${DIP_TURKISH_LOCALE_DIR}")
    endif()
  endif()
endif()
