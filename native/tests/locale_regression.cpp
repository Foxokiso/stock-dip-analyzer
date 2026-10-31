// Locale regression for number parsing in dip::jsonlite (and the futures prices read with it).
//
// strtod takes its decimal separator from LC_NUMERIC, so once a host program called
// setlocale(LC_ALL, "") under a comma-decimal locale (de_DE, fr_FR, ...; Qt does on Linux),
// "6789.25" parsed as 6789 and every futures price lost its fraction without an error. The
// parity drivers never call setlocale, so they cannot see this. This test switches the C
// locale to the first comma-decimal locale it finds and checks exact values. On Linux,
// configuring native/ compiles de_DE.UTF-8 into <build>/locales with localedef and CTest sets
// LOCPATH to it, so the test runs where no such locale is installed (CI images); Windows
// ships one. It exits with 77, which CTest reports as skipped, only when no comma-decimal
// locale is available (for instance, glibc's locale sources are missing). Outside CTest:
//   LOCPATH=<build>/locales <build>/locale_regression tests/fixtures/futures-reference.json
//
// Usage: locale_regression <tests/fixtures/futures-reference.json>
#include "dip/futures.hpp"
#include "dip/jsonlite.hpp"

#include <clocale>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

int failures = 0;

void expectEqual(double actual, double expected, std::string_view what) {
    if (actual == expected && std::signbit(actual) == std::signbit(expected)) return;
    ++failures;
    std::cerr << "FAIL " << what << ": " << actual << " != " << expected << '\n';
}

double parsed(std::string_view text) { return dip::jsonlite::parse(text).asNumber(); }

const dip::futures::Quote& quoteOf(const dip::futures::Snapshot& snapshot, std::string_view symbol) {
    for (const auto& quote : snapshot.quotes) {
        if (quote.symbol == symbol) return quote;
    }
    throw std::runtime_error("fixture has no " + std::string(symbol));
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: locale_regression <futures-reference.json>\n";
        return 2;
    }
    const char* const candidates[] = {
        "de_DE.UTF-8", "de_DE.utf8", "de_DE", "fr_FR.UTF-8", "fr_FR.utf8", "fr_FR",
        "de-DE", "German_Germany.1252",  // Windows names
    };
    const char* active = nullptr;
    for (const char* name : candidates) {
        if (std::setlocale(LC_ALL, name) != nullptr && std::localeconv()->decimal_point[0] == ',') {
            active = name;
            break;
        }
    }
    if (active == nullptr) {
        std::setlocale(LC_ALL, "C");
        std::cout << "SKIPPED: no comma-decimal locale is installed (tried de_DE and fr_FR). "
                     "Build one with localedef and point LOCPATH at it to run this test.\n";
        return 77;
    }
    // The C library itself now stops at '.', which is what jsonlite must not do.
    std::cout << "LC_ALL=" << active << ": strtod(\"6789.25\") = " << std::strtod("6789.25", nullptr) << '\n';
    std::cerr.precision(17);

    try {
        expectEqual(parsed("6789.25"), 6789.25, "6789.25");
        expectEqual(parsed("-0.6977"), -0.6977, "-0.6977");
        expectEqual(parsed("1.5e3"), 1500.0, "1.5e3");
        expectEqual(parsed("2.5E-3"), 0.0025, "2.5E-3");
        expectEqual(parsed("1e400"), HUGE_VAL, "1e400 overflows to Infinity");
        expectEqual(parsed("-1e-400"), -0.0, "-1e-400 underflows to -0");

        std::ifstream file(argv[1], std::ios::binary);
        if (!file) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        std::stringstream text;
        text << file.rdbuf();
        dip::futures::ParseOptions options;
        options.fetchedAt = "2026-10-11T01:51:13.000Z";
        const dip::futures::Snapshot snapshot = dip::futures::parseFinvizFutures(text.str(), options);
        expectEqual(*quoteOf(snapshot, "ZN").price, 104.609375, "ZN price (Treasury 32nds)");
        expectEqual(*quoteOf(snapshot, "6A").price, 0.6977, "6A price");
        expectEqual(*quoteOf(snapshot, "CL").price, 91.66, "CL price");
        expectEqual(*quoteOf(snapshot, "CL").changePct, 0.39, "CL change %");
        expectEqual(quoteOf(snapshot, "ES").sparkline.at(0), 7849.25, "ES first sample");
    } catch (const std::exception& error) {
        ++failures;
        std::cerr << "FAIL: " << error.what() << '\n';
    }
    std::cout << (failures == 0 ? "PASSED" : "FAILED") << " under " << active << '\n';
    return failures == 0 ? 0 : 1;
}
