// dip::futures — C++20 port of the pure (network-free, clock-free) parts of
// src/services/futures.js: the instrument groups and group lookup, bond units, the
// readPayload rule (raw JSON, or the Finviz page's typed init-data script and nothing
// executable), per-row source quote validation and the parseFinvizFutures snapshot.
//
// This preserves the existing behavior of the reference application so the two can be
// compared field by field (scripts/verify-native-futures.mjs); it is not a trading
// backtest. It never invents a quote: a row that does not validate is 'unavailable' and
// a payload with no usable row is rejected with the reference's error message.
//
// Not ported here because they need IPC, a clock or previous state: fetchFinvizFutures,
// mergePrevious, failedSnapshot. `fetchedAt` is supplied by the caller as an already
// normalized ISO-8601 string; this library reads no clock.
//
// String semantics: strings are UTF-8 (WTF-8 for lone surrogates, see dip::jsonlite).
// Where the JavaScript reference trims or slices, this port applies String.prototype.trim's
// whitespace set and slices by UTF-16 code units so names and labels match exactly.
#pragma once

#include "dip/jsonlite.hpp"

#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace dip::futures {

inline constexpr std::string_view kSourceUrl = "https://finviz.com/futures.ashx";
inline constexpr std::string_view kApiUrl = "https://finviz.com/api/futures_all";
// Finviz's FAQ still specifies 20 minutes although the page footer says 15; the
// conservative disclosure is kept. Neither is a freshness SLA.
inline constexpr int kDelayMinutes = 20;
inline constexpr std::string_view kDefaultTimeframe = "i5";

struct Timeframe {
    std::string_view id;
    std::string_view label;
};
const std::vector<Timeframe>& timeframes();
bool isSupportedTimeframe(std::string_view id);

// Finviz roots are reference instruments, not a confirmed delivery contract.
struct Group {
    std::string_view id;
    std::string_view label;
    std::vector<std::string_view> symbols;
};
const std::vector<Group>& groups();
std::string_view groupOf(std::string_view symbol);             // "other" when not listed
bool isBondSymbol(std::string_view symbol) noexcept;            // ZT ZF ZN TN ZB UB
std::string_view unitOf(std::string_view symbol) noexcept;     // "points" for bonds, else "native quote"
bool isSymbolKey(std::string_view key) noexcept;               // /^[A-Z0-9]{1,8}$/

// Raised by readPayload / parseFinvizFutures with the reference's error messages.
// Invalid JSON surfaces as dip::jsonlite::ParseError (also a std::runtime_error).
class FuturesError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct Payload {
    jsonlite::Value data;
    bool fromPage;
};

// Accepts a raw JSON text, or an HTML page from which ONLY the body of the first <script>
// whose attributes contain id="futures-init-data" and type="application/json" (either
// quote style, either attribute order, ASCII case-insensitive) is parsed as JSON. Nothing
// is ever evaluated. Throws jsonlite::ParseError for invalid JSON and FuturesError when a
// page has no such script.
Payload readPayload(std::string_view input);

struct Quote {
    std::string symbol;
    std::string name;
    std::string group;
    std::string status;  // "delayed" | "unavailable"
    std::optional<double> price;
    std::optional<double> changePct;
    // Despite Finviz's field name (changeUsd) this is change in the instrument's native
    // price units: index points, bond points, cents, dollars, etc.
    std::optional<double> change;
    std::optional<double> prevClose;
    std::optional<double> high;
    std::optional<double> low;
    std::vector<double> sparkline;
    // Key/label pairs (keys are digit strings) in JavaScript enumeration order.
    std::vector<std::pair<std::string, std::string>> chartLabels;
    std::string unit;
    std::optional<std::string> quotedAt;   // always nullopt: the source gives no quote time
    std::optional<std::string> contract;   // always nullopt: roots are reference instruments
    std::optional<std::string> fetchedAt;  // nullopt when the row is unavailable
    std::string sourceUrl;
};

// Validates one source record for `symbol` (identity match plus finite numeric last and
// change; optional fields null when non-finite; sparkline only when every point is
// numeric; chart labels only for numeric indexes below the sparkline length).
Quote sourceQuote(std::string_view symbol, const jsonlite::Value& data,
                  std::string_view fetchedAt, std::string_view sourceUrl);

struct Snapshot {
    std::string source;     // "Finviz"
    std::string sourceUrl;
    std::string timeframe;
    std::string status;     // "delayed"
    bool cached = false;
    bool partial = false;
    std::optional<std::string> fetchedAt;
    std::string attemptedAt;
    std::optional<std::string> quotedAt;  // always nullopt
    int delayMinutes = kDelayMinutes;
    std::vector<Quote> quotes;
    std::optional<std::string> error;
};

struct ParseOptions {
    std::string fetchedAt;                 // normalized ISO-8601 timestamp from the caller
    std::optional<std::string> timeframe;  // nullopt -> kDefaultTimeframe
    std::optional<std::string> sourceUrl;  // nullopt -> page URL, or API URL + "?timeframe="
};

// Parses real API JSON or the futures page's JSON script without executing anything.
Snapshot parseFinvizFutures(std::string_view input, const ParseOptions& options);

}  // namespace dip::futures
