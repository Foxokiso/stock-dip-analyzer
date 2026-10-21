// Test-only line protocol for cross-language parity checks of dip::oilnews.
//
//   oilnews_driver [titles|links|order]      (default: titles)
//
//   titles: one trimmed raw <title> per line, optionally followed by a TAB and the
//           trimmed <source> element text. Output: title TAB source TAB 0|1.
//   links:  one trimmed <link> per line. Output: 0|1 (safe).
//   order:  one line of space-separated 0/1 highImpact flags in insertion order.
//           Output: the display order as space-separated indices.
//
// Input is UTF-8 bytes; titles must not contain TAB, CR or LF (line protocol).
// No floating-point values are emitted, so no precision setting is needed.
#include "dip/oilnews.hpp"

#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
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
            std::vector<bool> flags;
            int flag = 0;
            while (input >> flag) flags.push_back(flag != 0);
            const char* separator = "";
            for (const std::size_t index : dip::oilnews::orderHeadlines(flags)) {
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
