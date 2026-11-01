// Test-only line protocol for cross-language parity checks of dip::oilnews.
//
//   oilnews_driver [titles|links|order]      (default: titles)
//
//   titles: one trimmed raw <title> per line, optionally followed by a TAB and the
//           trimmed <source> element text. Output: title TAB source TAB 0|1.
//   links:  one trimmed <link> per line. Output: 0|1 (safe).
//   order:  one line of space-separated tokens, one per accepted headline in feed order:
//           the 0/1 highImpact flag, followed by @ and Date.parse(publishedAt) in Unix
//           milliseconds when the headline is dated ("1@1761879394000", "0").
//           Output: the display order as space-separated indices.
//
// Input is UTF-8 bytes; titles must not contain TAB, CR or LF (line protocol).
// No floating-point values are emitted, so no precision setting is needed.
#include "dip/oilnews.hpp"

#include <charconv>
#include <cstdint>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

int main(int argc, char** argv) {
    const std::string mode = argc > 1 ? argv[1] : "titles";
    if (mode != "titles" && mode != "links" && mode != "order") {
        std::cerr << "usage: oilnews_driver [titles|links|order]\n";
        return 2;
    }
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (mode == "links") {
            std::cout << (dip::oilnews::isSafeLink(line) ? '1' : '0') << '\n';
        } else if (mode == "order") {
            std::istringstream input(line);
            std::vector<dip::oilnews::HeadlineKey> headlines;
            std::string token;
            while (input >> token) {
                dip::oilnews::HeadlineKey key;
                key.highImpact = token[0] == '1';
                if (const std::size_t at = token.find('@'); at != std::string::npos) {
                    std::int64_t milliseconds = 0;
                    const char* const end = token.data() + token.size();
                    const auto result = std::from_chars(token.data() + at + 1, end, milliseconds);
                    if (result.ec != std::errc{} || result.ptr != end) {
                        std::cerr << "oilnews_driver: bad order token " << token << '\n';
                        return 2;
                    }
                    key.publishedMs = milliseconds;
                }
                headlines.push_back(key);
            }
            const char* separator = "";
            for (const std::size_t index : dip::oilnews::orderHeadlines(headlines)) {
                std::cout << separator << index;
                separator = " ";
            }
            std::cout << '\n';
        } else {
            const std::string_view whole(line);
            const std::size_t tab = whole.find('\t');
            const std::string_view rawTitle = whole.substr(0, tab);
            const std::optional<std::string_view> sourceText = tab == std::string_view::npos
                ? std::nullopt : std::optional<std::string_view>(whole.substr(tab + 1));
            const auto headline = dip::oilnews::classifyHeadline(rawTitle, sourceText);
            std::cout << headline.title << '\t' << headline.source << '\t' << (headline.highImpact ? '1' : '0') << '\n';
        }
    }
    return 0;
}
