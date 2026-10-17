// dip::jsonlite — strict RFC 8259 reader. Preservation of JSON.parse behavior for the
// payloads this application reads; not a trading backtest.
#include "dip/jsonlite.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <utility>

namespace dip::jsonlite {

ParseError::ParseError(const std::string& message, std::size_t offset)
    : std::runtime_error("Invalid JSON: " + message + " (offset " + std::to_string(offset) + ")"),
      offset_(offset) {}

const Value* Object::find(std::string_view key) const noexcept {
    for (std::size_t index = 0; index < keys.size(); ++index) {
        if (keys[index] == key) return &values[index];
    }
    return nullptr;
}

Value* Object::find(std::string_view key) noexcept {
    for (std::size_t index = 0; index < keys.size(); ++index) {
        if (keys[index] == key) return &values[index];
    }
    return nullptr;
}

void Object::set(std::string key, Value value) {
    if (Value* existing = find(key)) {
        *existing = std::move(value);
        return;
    }
    keys.push_back(std::move(key));
    values.push_back(std::move(value));
}

std::size_t decodeUtf8(std::string_view text, std::size_t position, char32_t& codePoint) noexcept {
    const unsigned char lead = static_cast<unsigned char>(text[position]);
    codePoint = lead;
    std::size_t length = 0;
    if (lead < 0x80u) return 1;
    if ((lead & 0xE0u) == 0xC0u) length = 2;
    else if ((lead & 0xF0u) == 0xE0u) length = 3;
    else if ((lead & 0xF8u) == 0xF0u) length = 4;
    else return 1;
    if (position + length > text.size()) return 1;
    char32_t value = static_cast<char32_t>(lead & (0x7Fu >> length));
    for (std::size_t index = 1; index < length; ++index) {
        const unsigned char byte = static_cast<unsigned char>(text[position + index]);
        if ((byte & 0xC0u) != 0x80u) return 1;
        value = static_cast<char32_t>((value << 6) | (byte & 0x3Fu));
    }
    codePoint = value;
    return length;
}

void appendUtf8(std::string& out, char32_t codePoint) {
    if (codePoint < 0x80u) {
        out.push_back(static_cast<char>(codePoint));
    } else if (codePoint < 0x800u) {
        out.push_back(static_cast<char>(0xC0u | (codePoint >> 6)));
        out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
    } else if (codePoint < 0x10000u) {
        out.push_back(static_cast<char>(0xE0u | (codePoint >> 12)));
        out.push_back(static_cast<char>(0x80u | ((codePoint >> 6) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
    } else {
        out.push_back(static_cast<char>(0xF0u | (codePoint >> 18)));
        out.push_back(static_cast<char>(0x80u | ((codePoint >> 12) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | ((codePoint >> 6) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
    }
}

namespace {

unsigned char byteAt(std::string_view text, std::size_t index) noexcept {
    return static_cast<unsigned char>(text[index]);
}

bool isContinuation(unsigned char byte) noexcept { return (byte & 0xC0u) == 0x80u; }

int hexDigit(unsigned char byte) noexcept {
    if (byte >= '0' && byte <= '9') return byte - '0';
    if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
    if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
    return -1;
}

// Nearest double for a grammar-checked JSON number literal. strtod is correctly rounded
// on the supported C libraries (UCRT, glibc) and yields the +-infinity / zero / subnormal
// result that JavaScript's JSON.parse produces on overflow and underflow. The literal has
// already been validated against the JSON grammar, so strtod never sees hex, "inf" or
// "nan" spellings, and the only decimal separator is '.'; this library never changes the
// C locale, which stays "C" unless the host program sets another one.
double toDouble(std::string_view literal) {
    const std::string text(literal);
    return std::strtod(text.c_str(), nullptr);
}

class Parser {
public:
    explicit Parser(std::string_view text) noexcept : text_(text) {}

    Value parseDocument() {
        skipWhitespace();
        if (atEnd()) fail("unexpected end of input");
        Value value = parseValue();
        skipWhitespace();
        if (!atEnd()) fail("unexpected trailing characters");
        return value;
    }

private:
    std::string_view text_;
    std::size_t position_ = 0;
    int depth_ = 0;

    [[noreturn]] void fail(const char* message) const { throw ParseError(message, position_); }

    bool atEnd() const noexcept { return position_ >= text_.size(); }
    unsigned char peek() const noexcept { return byteAt(text_, position_); }

    void skipWhitespace() noexcept {
        while (!atEnd()) {
            const unsigned char byte = peek();
            if (byte != ' ' && byte != '\t' && byte != '\n' && byte != '\r') break;
            ++position_;
        }
    }

    void expect(unsigned char byte, const char* message) {
        if (atEnd() || peek() != byte) fail(message);
        ++position_;
    }

    Value parseValue() {
        if (atEnd()) fail("unexpected end of input");
        const unsigned char byte = peek();
        if (byte == '{') return parseObject();
        if (byte == '[') return parseArray();
        if (byte == '"') return Value(parseString());
        if (byte == 't') return parseLiteral("true", Value(true));
        if (byte == 'f') return parseLiteral("false", Value(false));
        if (byte == 'n') return parseLiteral("null", Value(nullptr));
        if (byte == '-' || (byte >= '0' && byte <= '9')) return Value(parseNumber());
        fail("unexpected character");
    }

    Value parseLiteral(std::string_view literal, Value value) {
        if (text_.substr(position_, literal.size()) != literal) fail("invalid literal");
        position_ += literal.size();
        return value;
    }

    void enter() {
        if (++depth_ > kMaxDepth) fail("nesting too deep");
    }

    void leave() noexcept { --depth_; }

    Value parseObject() {
        enter();
        ++position_;  // '{'
        Object object;
        skipWhitespace();
        if (!atEnd() && peek() == '}') {
            ++position_;
            leave();
            return Value(std::move(object));
        }
        for (;;) {
            skipWhitespace();
            if (atEnd() || peek() != '"') fail("expected a string key");
            std::string key = parseString();
            skipWhitespace();
            expect(':', "expected ':' after key");
            skipWhitespace();
            Value member = parseValue();
            object.set(std::move(key), std::move(member));
            skipWhitespace();
            if (atEnd()) fail("unterminated object");
            if (peek() == ',') { ++position_; continue; }
            if (peek() == '}') { ++position_; break; }
            fail("expected ',' or '}' in object");
        }
        leave();
        return Value(std::move(object));
    }

    Value parseArray() {
        enter();
        ++position_;  // '['
        Array array;
        skipWhitespace();
        if (!atEnd() && peek() == ']') {
            ++position_;
            leave();
            return Value(std::move(array));
        }
        for (;;) {
            skipWhitespace();
            array.push_back(parseValue());
            skipWhitespace();
            if (atEnd()) fail("unterminated array");
            if (peek() == ',') { ++position_; continue; }
            if (peek() == ']') { ++position_; break; }
            fail("expected ',' or ']' in array");
        }
        leave();
        return Value(std::move(array));
    }

    char32_t parseHex4() {
        if (position_ + 4 > text_.size()) fail("truncated \\u escape");
        char32_t code = 0;
        for (int index = 0; index < 4; ++index) {
            const int digit = hexDigit(peek());
            if (digit < 0) fail("invalid hex digit in \\u escape");
            code = (code << 4) | static_cast<char32_t>(digit);
            ++position_;
        }
        return code;
    }

    void parseEscape(std::string& out) {
        if (atEnd()) fail("unterminated string escape");
        const unsigned char byte = peek();
        ++position_;
        switch (byte) {
            case '"': out.push_back('"'); return;
            case '\\': out.push_back('\\'); return;
            case '/': out.push_back('/'); return;
            case 'b': out.push_back('\b'); return;
            case 'f': out.push_back('\f'); return;
            case 'n': out.push_back('\n'); return;
            case 'r': out.push_back('\r'); return;
            case 't': out.push_back('\t'); return;
            case 'u': break;
            default: fail("invalid escape sequence");
        }
        char32_t codePoint = parseHex4();
        if (codePoint >= 0xD800u && codePoint <= 0xDBFFu) {
            // High surrogate: pair it with an immediately following low surrogate escape.
            if (text_.substr(position_, 2) == "\\u") {
                const std::size_t resume = position_;
                position_ += 2;
                const char32_t low = parseHex4();
                if (low >= 0xDC00u && low <= 0xDFFFu) {
                    codePoint = 0x10000u + ((codePoint - 0xD800u) << 10) + (low - 0xDC00u);
                } else {
                    position_ = resume;  // lone high surrogate; the next escape is read normally
                }
            }
        }
        appendUtf8(out, codePoint);
    }

    // Validates one raw (unescaped) UTF-8 sequence and copies it verbatim.
    void copyUtf8Sequence(std::string& out) {
        const unsigned char lead = peek();
        std::size_t length = 0;
        unsigned char secondMin = 0x80u;
        unsigned char secondMax = 0xBFu;
        if (lead >= 0xC2u && lead <= 0xDFu) {
            length = 2;
        } else if (lead == 0xE0u) {
            length = 3;
            secondMin = 0xA0u;
        } else if ((lead >= 0xE1u && lead <= 0xECu) || lead == 0xEEu || lead == 0xEFu) {
            length = 3;
        } else if (lead == 0xEDu) {
            length = 3;
            secondMax = 0x9Fu;  // excludes encoded surrogates
        } else if (lead == 0xF0u) {
            length = 4;
            secondMin = 0x90u;
        } else if (lead >= 0xF1u && lead <= 0xF3u) {
            length = 4;
        } else if (lead == 0xF4u) {
            length = 4;
            secondMax = 0x8Fu;
        } else {
            fail("invalid UTF-8 byte in string");
        }
        if (position_ + length > text_.size()) fail("truncated UTF-8 sequence in string");
        const unsigned char second = byteAt(text_, position_ + 1);
        if (second < secondMin || second > secondMax) fail("invalid UTF-8 sequence in string");
        for (std::size_t index = 2; index < length; ++index) {
            if (!isContinuation(byteAt(text_, position_ + index))) fail("invalid UTF-8 sequence in string");
        }
        out.append(text_.substr(position_, length));
        position_ += length;
    }

    std::string parseString() {
        ++position_;  // opening quote
        std::string out;
        for (;;) {
            if (atEnd()) fail("unterminated string");
            const unsigned char byte = peek();
            if (byte == '"') { ++position_; return out; }
            if (byte == '\\') { ++position_; parseEscape(out); continue; }
            if (byte < 0x20u) fail("control character in string");
            if (byte < 0x80u) { out.push_back(static_cast<char>(byte)); ++position_; continue; }
            copyUtf8Sequence(out);
        }
    }

    bool consumeDigits() noexcept {
        const std::size_t start = position_;
        while (!atEnd() && peek() >= '0' && peek() <= '9') ++position_;
        return position_ > start;
    }

    double parseNumber() {
        const std::size_t start = position_;
        if (peek() == '-') ++position_;
        if (atEnd()) fail("expected digits");
        if (peek() == '0') {
            ++position_;
        } else if (peek() >= '1' && peek() <= '9') {
            consumeDigits();
        } else {
            fail("expected digits");
        }
        if (!atEnd() && peek() == '.') {
            ++position_;
            if (!consumeDigits()) fail("expected fraction digits");
        }
        if (!atEnd() && (peek() == 'e' || peek() == 'E')) {
            ++position_;
            if (!atEnd() && (peek() == '+' || peek() == '-')) ++position_;
            if (!consumeDigits()) fail("expected exponent digits");
        }
        return toDouble(text_.substr(start, position_ - start));
    }
};

}  // namespace

Value parse(std::string_view text) {
    Parser parser(text);
    return parser.parseDocument();
}

bool isArrayIndexKey(std::string_view key) noexcept {
    if (key.empty() || key.size() > 10) return false;
    if (key.size() > 1 && key[0] == '0') return false;
    std::uint64_t value = 0;
    for (const char c : key) {
        if (c < '0' || c > '9') return false;
        value = value * 10u + static_cast<std::uint64_t>(c - '0');
    }
    return value <= 4294967294u;
}

std::vector<std::size_t> enumerationOrder(const Object& object) {
    std::vector<std::size_t> indices;
    std::vector<std::size_t> others;
    indices.reserve(object.size());
    for (std::size_t index = 0; index < object.size(); ++index) {
        (isArrayIndexKey(object.keys[index]) ? indices : others).push_back(index);
    }
    // Canonical integer strings compare numerically by (length, lexical); keys are unique.
    std::sort(indices.begin(), indices.end(), [&](std::size_t a, std::size_t b) {
        const std::string& left = object.keys[a];
        const std::string& right = object.keys[b];
        return left.size() != right.size() ? left.size() < right.size() : left < right;
    });
    indices.insert(indices.end(), others.begin(), others.end());
    return indices;
}

}  // namespace dip::jsonlite
