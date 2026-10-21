# dip::jsonlite — strict RFC 8259 JSON reader (what JSON.parse accepts and yields for the
# payloads this application reads). It is a dependency of dip::futures and is exercised by
# that module's parity test (futures_reference_parity: malformed documents, escapes,
# surrogate pairs, number forms, duplicate and "__proto__" keys, enumeration order), so it
# registers no driver of its own.
add_library(dip_jsonlite src/jsonlite.cpp)
target_include_directories(dip_jsonlite PUBLIC include)
dip_set_policy(dip_jsonlite)
