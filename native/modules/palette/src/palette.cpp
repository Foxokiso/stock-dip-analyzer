// dip::palette -- the Pierce/27 color system shared with src/styles/tokens.css.
//
// The token table in dip/palette.hpp is generated from the CSS; the operations
// here preserve what the Electron renderer does with those tokens: the
// 27-degree OKLCH hue grid (slot k + 20 is the exact complement), multiplied
// tints (lightness and chroma scaled together), and OKLCH -> sRGB conversion
// with Chromium's per-channel clipping of linear light to [0, 1]. This is
// preservation of existing presentation behavior, not a trading backtest.
#include "dip/palette.hpp"

#include <algorithm>
#include <cmath>
#include <initializer_list>

namespace dip::palette {
namespace {
constexpr double kPi = 3.141592653589793;

int floorMod(int value, int modulus) {
    const int remainder = value % modulus;
    return remainder < 0 ? remainder + modulus : remainder;
}

// IEC 61966-2-1 sRGB transfer function for an already clipped linear channel.
double transfer(double linear) {
    return linear <= 0.0031308 ? 12.92 * linear : 1.055 * std::pow(linear, 1.0 / 2.4) - 0.055;
}

// Rounds half-up to 8 bits. Clamped before the integer cast so +/-infinity are
// well-defined (255 / 0, as Math.min/Math.max give in JS); NaN maps to 0.
int channelByte(double gamma) {
    if (std::isnan(gamma)) return 0;
    return static_cast<int>(std::clamp(std::floor(gamma * 255.0 + 0.5), 0.0, 255.0));
}
}  // namespace

int hueDegrees(int k) { return floorMod(kHueStep * floorMod(k, kGridSlots), 360); }

// k is reduced to its slot first so k + kComplementOffset cannot overflow.
int complementIndex(int k) { return floorMod(floorMod(k, kGridSlots) + kComplementOffset, kGridSlots); }

int complement(int k) { return hueDegrees(complementIndex(k)); }

Oklch tint(Oklch color, double factor) { return {color.l * factor, color.c * factor, color.h}; }

// Bjorn Ottosson's OKLab reference matrices, in the same operation order as
// scripts/gen-native-palette.mjs so both sides agree to floating-point noise.
Rgb toSrgb(Oklch color) {
    const double radians = color.h * (kPi / 180.0);
    const double a = color.c * std::cos(radians);
    const double b = color.c * std::sin(radians);
    const double l1 = color.l + 0.3963377774 * a + 0.2158037573 * b;
    const double m1 = color.l - 0.1055613458 * a - 0.0638541728 * b;
    const double s1 = color.l - 0.0894841775 * a - 1.2914855480 * b;
    const double l3 = l1 * l1 * l1;
    const double m3 = m1 * m1 * m1;
    const double s3 = s1 * s1 * s1;
    const double linearR = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const double linearG = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const double linearB = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
    bool clipped = false;
    const auto encode = [&clipped](double linear) {
        if (linear < 0.0 || linear > 1.0) clipped = true;
        return transfer(std::clamp(linear, 0.0, 1.0));
    };
    const double r = encode(linearR);
    const double g = encode(linearG);
    const double bb = encode(linearB);
    return {r, g, bb, clipped};
}

std::string toHex(Rgb rgb) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string out = "#";
    for (const double channel : {rgb.r, rgb.g, rgb.b}) {
        const int byte = channelByte(channel);
        out += digits[byte >> 4];
        out += digits[byte & 15];
    }
    return out;
}

const Token* lookup(std::string_view name) {
    if (name.size() >= 2 && name.substr(0, 2) == "--") name.remove_prefix(2);
    for (const Token& token : kTokens) {
        if (token.name == name) return &token;
    }
    return nullptr;
}
}  // namespace dip::palette
