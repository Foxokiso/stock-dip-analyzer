# dip::jsonlite — strict RFC 8259 JSON reader (what JSON.parse accepts and yields for the
# payloads this application reads). It is a dependency of dip::futures and is exercised by
# that module's parity test (futures_reference_parity: malformed documents, escapes,
# surrogate pairs, number forms, ill-formed UTF-8 bytes, duplicate and "__proto__" keys,
# large objects, enumeration order, the depth limit) and by locale_regression (numbers
# under a comma-decimal C locale), so it registers no driver of its own.
add_library(dip_jsonlite src/jsonlite.cpp)
target_include_directories(dip_jsonlite PUBLIC include)
dip_set_policy(dip_jsonlite)
