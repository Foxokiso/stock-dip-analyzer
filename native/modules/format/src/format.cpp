#include "dip/format.hpp"
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace dip::format {
namespace {
// U+2014 EM DASH, written as UTF-8 bytes so the source encoding cannot change it.
constexpr const char* kUnavailable = "\xE2\x80\x94";

// Minimal non-negative big integer (little-endian 32-bit limbs). It only has to hold a
// double below 1e21 scaled by up to 10^100 with its full 1074-bit fraction, so the few
// operations below are enough and nothing here allocates more than a few hundred limbs.
class BigUInt {
public:
    explicit BigUInt(std::uint64_t value) {
        limbs_.push_back(static_cast<std::uint32_t>(value));
        limbs_.push_back(static_cast<std::uint32_t>(value >> 32));
        trim();
    }

    void multiply(std::uint32_t factor) {
        std::uint64_t carry = 0;
        for (auto& limb : limbs_) {
            const std::uint64_t product = static_cast<std::uint64_t>(limb) * factor + carry;
            limb = static_cast<std::uint32_t>(product);
            carry = product >> 32;
        }
        if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
    }

    // this += 2^bit
    void addPowerOfTwo(int bit) {
        const auto index = static_cast<std::size_t>(bit / 32);
        if (limbs_.size() <= index) limbs_.resize(index + 1, 0);
        std::uint64_t carry = std::uint64_t{1} << (bit % 32);
        for (std::size_t i = index; carry != 0 && i < limbs_.size(); ++i) {
            const std::uint64_t sum = static_cast<std::uint64_t>(limbs_[i]) + carry;
            limbs_[i] = static_cast<std::uint32_t>(sum);
            carry = sum >> 32;
        }
        if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
    }

    void shiftLeft(int bits) {
        const auto words = static_cast<std::size_t>(bits / 32);
        const int remainder = bits % 32;
        if (remainder != 0) {
            std::uint32_t carry = 0;
            for (auto& limb : limbs_) {
                const std::uint64_t shifted = (static_cast<std::uint64_t>(limb) << remainder) | carry;
                limb = static_cast<std::uint32_t>(shifted);
                carry = static_cast<std::uint32_t>(shifted >> 32);
            }
            if (carry != 0) limbs_.push_back(carry);
        }
        limbs_.insert(limbs_.begin(), words, 0u);
        trim();
    }

    void shiftRight(int bits) {
        const auto words = static_cast<std::size_t>(bits / 32);
        const int remainder = bits % 32;
        if (words >= limbs_.size()) {
            limbs_.clear();
            return;
        }
        limbs_.erase(limbs_.begin(), limbs_.begin() + static_cast<std::ptrdiff_t>(words));
        if (remainder != 0) {
            for (std::size_t i = 0; i < limbs_.size(); ++i) {
                const std::uint64_t high = i + 1 < limbs_.size() ? limbs_[i + 1] : 0u;
                limbs_[i] = static_cast<std::uint32_t>(((high << 32) | limbs_[i]) >> remainder);
            }
        }
        trim();
    }

    std::string toDecimal() const {
        if (limbs_.empty()) return "0";
        constexpr std::uint64_t kChunk = 1000000000u;  // nine decimal digits per division
        std::vector<std::uint32_t> work = limbs_;
        std::vector<std::uint32_t> chunks;
        while (!work.empty()) {
            std::uint64_t remainder = 0;
            for (std::size_t i = work.size(); i-- > 0;) {
                const std::uint64_t current = (remainder << 32) | work[i];
                work[i] = static_cast<std::uint32_t>(current / kChunk);
                remainder = current % kChunk;
            }
            chunks.push_back(static_cast<std::uint32_t>(remainder));
            while (!work.empty() && work.back() == 0) work.pop_back();
        }
        std::string out = std::to_string(chunks.back());
        for (std::size_t i = chunks.size() - 1; i-- > 0;) {
            const std::string part = std::to_string(chunks[i]);
            out.append(9 - part.size(), '0');
            out += part;
        }
        return out;
    }

private:
    void trim() {
        while (!limbs_.empty() && limbs_.back() == 0) limbs_.pop_back();
    }
    std::vector<std::uint32_t> limbs_;
};

// The shortest round-trip decimal of a non-negative finite double in the ECMAScript
// Number::toString convention: value == 0.d1d2...dk × 10^n, digits never end in '0'
// (except the single digit "0" for zero).
struct ShortestDecimal {
    std::string digits;
    int n{};
};

ShortestDecimal shortestDecimal(double magnitude) {
    char buffer[64];
    // Shortest representation that round-trips; ties resolved to the nearest even
    // candidate, exactly the rule ECMAScript specifies for Number::toString.
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), magnitude,
                                      std::chars_format::scientific);
    if (result.ec != std::errc{}) throw std::runtime_error("to_chars failed");
    const std::string text(buffer, result.ptr);
    const auto e = text.find('e');
    ShortestDecimal decimal;
    for (std::size_t i = 0; i < e; ++i) {
        if (text[i] != '.') decimal.digits += text[i];
    }
    while (decimal.digits.size() > 1 && decimal.digits.back() == '0') decimal.digits.pop_back();
    decimal.n = std::stoi(text.substr(e + 1)) + 1;
    return decimal;
}

std::string zeros(int count) {
    return std::string(static_cast<std::size_t>(count), '0');
}

// Rounds (digits, n) to at most `fraction` fraction digits, half away from zero.
// This is ICU's "halfExpand" applied to the shortest decimal, which is what
// Intl.NumberFormat does for a double.
void roundHalfExpand(ShortestDecimal& decimal, int fraction) {
    const int keep = decimal.n + fraction;
    bool roundUp = false;
    if (keep < 0) {
        decimal.digits.clear();
    } else if (keep == 0) {
        roundUp = decimal.digits[0] >= '5';
        decimal.digits.clear();
    } else if (decimal.digits.size() > static_cast<std::size_t>(keep)) {
        roundUp = decimal.digits[static_cast<std::size_t>(keep)] >= '5';
        decimal.digits.resize(static_cast<std::size_t>(keep));
    }
    if (roundUp) {
        std::size_t i = decimal.digits.size();
        while (i > 0 && decimal.digits[i - 1] == '9') decimal.digits[--i] = '0';
        if (i == 0) {
            decimal.digits.insert(decimal.digits.begin(), '1');
            decimal.n += 1;
        } else {
            decimal.digits[i - 1] = static_cast<char>(decimal.digits[i - 1] + 1);
        }
    }
    while (!decimal.digits.empty() && decimal.digits.back() == '0') decimal.digits.pop_back();
    if (decimal.digits.empty()) {
        decimal.digits = "0";
        decimal.n = 1;
    }
}

std::string groupThousands(const std::string& integer) {
    std::string out;
    const std::size_t length = integer.size();
    for (std::size_t i = 0; i < length; ++i) {
        if (i > 0 && (length - i) % 3 == 0) out += ',';
        out += integer[i];
    }
    return out;
}
}  // namespace

std::string numberToString(double value) {
    if (std::isnan(value)) return "NaN";
    if (value == 0) return "0";
    if (value < 0) return "-" + numberToString(-value);
    if (std::isinf(value)) return "Infinity";
    const ShortestDecimal decimal = shortestDecimal(value);
    const int k = static_cast<int>(decimal.digits.size());
    const int n = decimal.n;
    if (k <= n && n <= 21) return decimal.digits + zeros(n - k);
    if (0 < n && n <= 21) {
        return decimal.digits.substr(0, static_cast<std::size_t>(n)) + "." +
               decimal.digits.substr(static_cast<std::size_t>(n));
    }
    if (-6 < n && n <= 0) return "0." + zeros(-n) + decimal.digits;
    const int exponent = n - 1;
    const std::string suffix = std::string("e") + (exponent < 0 ? "-" : "+") +
                               std::to_string(exponent < 0 ? -exponent : exponent);
    if (k == 1) return decimal.digits + suffix;
    return decimal.digits.substr(0, 1) + "." + decimal.digits.substr(1) + suffix;
}

std::string toFixed(double value, int digits) {
    if (digits < 0 || digits > 100) throw std::out_of_range("toFixed() digits argument must be between 0 and 100");
    if (std::isnan(value)) return "NaN";
    if (std::isinf(value)) return value < 0 ? "-Infinity" : "Infinity";
    // ECMAScript tests x < 0, so -0 keeps no sign while -0.001 does ("-0.00").
    const bool negative = value < 0;
    const double magnitude = negative ? -value : value;
    if (magnitude >= 1e21) return (negative ? "-" : "") + numberToString(magnitude);

    // magnitude == mantissa × 2^exponent exactly (also for subnormals and zero).
    int exponent = 0;
    const double fraction = std::frexp(magnitude, &exponent);
    const auto mantissa = static_cast<std::uint64_t>(std::ldexp(fraction, 53));
    exponent -= 53;

    // n = floor(magnitude × 10^digits + 1/2): the integer whose n / 10^digits is closest
    // to the value, choosing the larger one on an exact tie, as the specification says.
    BigUInt scaled(mantissa);
    for (int i = 0; i < digits; ++i) scaled.multiply(10);
    if (exponent >= 0) {
        scaled.shiftLeft(exponent);
    } else {
        scaled.addPowerOfTwo(-exponent - 1);
        scaled.shiftRight(-exponent);
    }
    std::string decimal = scaled.toDecimal();
    const auto fractionDigits = static_cast<std::size_t>(digits);
    if (decimal.size() <= fractionDigits) decimal.insert(0, fractionDigits + 1 - decimal.size(), '0');

    std::string out = negative ? "-" : "";
    out += decimal.substr(0, decimal.size() - fractionDigits);
    if (digits > 0) {
        out += '.';
        out += decimal.substr(decimal.size() - fractionDigits);
    }
    return out;
}

std::string toLocaleStringEnUS(double value) {
    if (std::isnan(value)) return "NaN";
    // ICU keeps the sign of a negative input even when it rounds to zero, and shows it
    // for -0 as well ("-0"), unlike toFixed.
    const bool negative = std::signbit(value);
    const double magnitude = std::fabs(value);
    if (std::isinf(magnitude)) return negative ? "-\xE2\x88\x9E" : "\xE2\x88\x9E";  // U+221E
    ShortestDecimal decimal = shortestDecimal(magnitude);
    roundHalfExpand(decimal, 3);

    std::string integer, fraction;
    const auto k = decimal.digits.size();
    const int n = decimal.n;
    if (decimal.digits == "0") {
        integer = "0";
    } else if (n <= 0) {
        integer = "0";
        fraction = zeros(-n) + decimal.digits;
    } else if (k <= static_cast<std::size_t>(n)) {
        integer = decimal.digits + zeros(n - static_cast<int>(k));
    } else {
        integer = decimal.digits.substr(0, static_cast<std::size_t>(n));
        fraction = decimal.digits.substr(static_cast<std::size_t>(n));
    }
    std::string out = negative ? "-" : "";
    out += groupThousands(integer);
    if (!fraction.empty()) {
        out += '.';
        out += fraction;
    }
    return out;
}

// 1234567890 -> "1.23B", 4500000 -> "4.50M", unavailable -> "—"
std::string formatCompact(std::optional<double> value) {
    if (!value || !std::isfinite(*value)) return kUnavailable;
    const double n = *value;
    const double abs = std::fabs(n);
    if (abs >= 1e12) return toFixed(n / 1e12, 2) + "T";
    if (abs >= 1e9) return toFixed(n / 1e9, 2) + "B";
    if (abs >= 1e6) return toFixed(n / 1e6, 2) + "M";
    if (abs >= 1e3) return toFixed(n / 1e3, 1) + "K";
    return toLocaleStringEnUS(n);
}

// 2.345 -> "+2.35%", -1.2 -> "-1.20%", unavailable -> "—"
std::string formatPct(std::optional<double> value, int digits) {
    if (!value || !std::isfinite(*value)) return kUnavailable;
    const double n = *value;
    return (n > 0 ? "+" : "") + toFixed(n, digits) + "%";
}

// 12.3456 -> "$12.35", unavailable -> "—"
std::string formatPrice(std::optional<double> value) {
    if (!value || !std::isfinite(*value)) return kUnavailable;
    return "$" + toFixed(*value, 2);
}
}  // namespace dip::format
