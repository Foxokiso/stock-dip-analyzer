// Test-only line protocol for cross-language palette parity checks.
//
// One command per line on stdin, tab-separated fields on stdout:
//   constants                -> hueStep gridSlots complementOffset m1 m2 m3 fastMs slowMs pulseMs tokenCount
//   at <index>               -> token fields (see printToken) or "null"
//   token <name>             -> token fields for lookup(name) or "null"
//   oklch <l> <c> <h>        -> r g b hex clipped for toSrgb({l, c, h})
//   tint <name> <factor>     -> l c h r g b hex clipped for tint(lookup(name)->oklch, factor) or "null"
//   complement <k>           -> complement(k) complementIndex(k) hueDegrees(k)
#include "dip/palette.hpp"

#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

namespace {
void printRgb(const dip::palette::Rgb& rgb) {
    std::cout << rgb.r << '\t' << rgb.g << '\t' << rgb.b << '\t' << dip::palette::toHex(rgb) << '\t' << rgb.clipped;
}

// name alias l c h k hex rgb clipped | r g b hex clipped (recomputed from the oklch literal)
void printToken(const dip::palette::Token& token) {
    std::cout << token.name << '\t' << token.alias << '\t' << token.oklch.l << '\t' << token.oklch.c << '\t'
              << token.oklch.h << '\t' << token.k << '\t' << token.hex << '\t' << token.rgb << '\t'
              << token.clipped << '\t';
    printRgb(dip::palette::toSrgb(token.oklch));
}
}  // namespace

int main() {
    using namespace dip::palette;
    std::cout << std::setprecision(17);
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        std::string command;
        input >> command;
        if (command == "constants") {
            std::cout << kHueStep << '\t' << kGridSlots << '\t' << kComplementOffset << '\t' << kMultiply[0] << '\t'
                      << kMultiply[1] << '\t' << kMultiply[2] << '\t' << kFastMs << '\t' << kSlowMs << '\t'
                      << kPulseMs << '\t' << kTokenCount << '\n';
        } else if (command == "at") {
            unsigned long long index = 0;
            if (!(input >> index) || index >= kTokenCount) { std::cout << "null\n"; continue; }
            printToken(kTokens[static_cast<std::size_t>(index)]);
            std::cout << '\n';
        } else if (command == "token") {
            std::string name;
            const Token* token = (input >> name) ? lookup(name) : nullptr;
            if (!token) { std::cout << "null\n"; continue; }
            printToken(*token);
            std::cout << '\n';
        } else if (command == "oklch") {
            Oklch color{};
            if (!(input >> color.l >> color.c >> color.h)) { std::cout << "null\n"; continue; }
            printRgb(toSrgb(color));
            std::cout << '\n';
        } else if (command == "tint") {
            std::string name;
            double factor = 0;
            const Token* token = (input >> name >> factor) ? lookup(name) : nullptr;
            if (!token) { std::cout << "null\n"; continue; }
            const Oklch tinted = tint(token->oklch, factor);
            std::cout << tinted.l << '\t' << tinted.c << '\t' << tinted.h << '\t';
            printRgb(toSrgb(tinted));
            std::cout << '\n';
        } else if (command == "complement") {
            int k = 0;
            if (!(input >> k)) { std::cout << "null\n"; continue; }
            std::cout << complement(k) << '\t' << complementIndex(k) << '\t' << hueDegrees(k) << '\n';
        } else {
            std::cout << "null\n";
        }
    }
}
