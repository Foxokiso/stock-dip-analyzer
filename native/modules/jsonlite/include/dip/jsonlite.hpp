// dip::jsonlite — strict RFC 8259 JSON reader for the native port.
//
// This module preserves existing behavior (what JSON.parse accepts from the Finviz
// payloads and what it yields); it is not a trading backtest. It performs no network
// access and has no third-party dependencies.
//
// Scope and guarantees:
//   * Objects keep their keys in first-insertion order; a duplicate key replaces the
//     earlier value in place, exactly as JSON.parse does. enumerationOrder() reproduces
//     the order in which JavaScript enumerates the same properties (array-index keys
//     first in ascending order, then the rest in insertion order).
//   * "__proto__", "constructor" and similar names are ordinary key strings. There is no
//     prototype here, so nothing can be polluted.
//   * Strings are decoded to UTF-8. A lone surrogate escape (\uD83D without its pair,
//     which JSON.parse tolerates) is kept in its WTF-8 three-byte form so JavaScript
//     string semantics survive the round trip. Raw bytes must be well-formed UTF-8: pass
//     bytes from the network through decodeUtf8Lossy first, as the renderer's
//     Response.text() decodes them before JSON.parse ever sees them.
//   * Numbers follow the RFC grammar and convert to the nearest double whatever the C
//     locale (overflow gives +-infinity and underflow +-0 like JavaScript; the value type
//     cannot otherwise hold a non-finite number).
//   * Anything else — trailing text, comments, single quotes, NaN, leading zeros, control
//     characters inside strings, nesting deeper than kMaxDepth — throws ParseError.
#pragma once

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace dip::jsonlite {

class Value;
using Array = std::vector<Value>;

// Ordered key/value container. Two parallel vectors keep `Value` an incomplete type here,
// which std::vector permits but std::pair would not.
class Object {
public:
    std::vector<std::string> keys;
    std::vector<Value> values;

    std::size_t size() const noexcept { return keys.size(); }
    bool empty() const noexcept { return keys.empty(); }
    const Value* find(std::string_view key) const noexcept;
    Value* find(std::string_view key) noexcept;
    bool contains(std::string_view key) const noexcept { return find(key) != nullptr; }
    // Inserts, or replaces the value of an existing key while keeping its first position.
    // Searches linearly; parse() indexes the keys of large objects instead.
    void set(std::string key, Value value);
};

enum class Type { null, boolean, number, string, array, object };

class ParseError : public std::runtime_error {
public:
    ParseError(const std::string& message, std::size_t offset);
    // Byte offset into the input text where parsing stopped.
    std::size_t offset() const noexcept { return offset_; }
private:
    std::size_t offset_;
};

class Value {
public:
    Value() noexcept : data_(nullptr) {}
    explicit Value(std::nullptr_t) noexcept : data_(nullptr) {}
    explicit Value(bool boolean) noexcept : data_(boolean) {}
    explicit Value(double number) noexcept : data_(number) {}
    explicit Value(std::string text) : data_(std::move(text)) {}
    explicit Value(const char* text) : data_(std::string(text)) {}
    explicit Value(Array array) : data_(std::move(array)) {}
    explicit Value(Object object) : data_(std::move(object)) {}

    Type type() const noexcept { return static_cast<Type>(data_.index()); }
    bool isNull() const noexcept { return type() == Type::null; }
    bool isBoolean() const noexcept { return type() == Type::boolean; }
    bool isNumber() const noexcept { return type() == Type::number; }
    bool isString() const noexcept { return type() == Type::string; }
    bool isArray() const noexcept { return type() == Type::array; }
    bool isObject() const noexcept { return type() == Type::object; }

    // Checked accessors: throw std::bad_variant_access on a type mismatch.
    bool asBoolean() const { return std::get<bool>(data_); }
    double asNumber() const { return std::get<double>(data_); }
    const std::string& asString() const { return std::get<std::string>(data_); }
    const Array& asArray() const { return std::get<Array>(data_); }
    const Object& asObject() const { return std::get<Object>(data_); }
    Array& asArray() { return std::get<Array>(data_); }
    Object& asObject() { return std::get<Object>(data_); }

    // Unchecked accessors: nullptr when the value is not of that type.
    const bool* ifBoolean() const noexcept { return std::get_if<bool>(&data_); }
    const double* ifNumber() const noexcept { return std::get_if<double>(&data_); }
    const std::string* ifString() const noexcept { return std::get_if<std::string>(&data_); }
    const Array* ifArray() const noexcept { return std::get_if<Array>(&data_); }
    const Object* ifObject() const noexcept { return std::get_if<Object>(&data_); }

private:
    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> data_;
};

// Deepest permitted nesting of arrays/objects, the outermost one included. JSON.parse has
// no depth limit at all (V8's parser is iterative; Node 22 parses 10,000,000 levels), so
// refusing deeper input is a deliberate divergence that bounds this recursive parser's
// stack on hostile input. The futures verifier asserts both sides of the limit.
inline constexpr int kMaxDepth = 512;

// Parses one complete JSON text. Surrounding RFC whitespace (space, tab, LF, CR) is
// allowed; anything else before or after the value is an error.
Value parse(std::string_view text);

// True when `key` is an ECMAScript array index: a canonical decimal integer string
// ("0", "12"; no sign, no leading zero) whose value is at most 2^32 - 2.
bool isArrayIndexKey(std::string_view key) noexcept;

// Positions of `object`'s members in the order Object.keys / Object.entries / for-in
// enumerate a JSON.parse result (OrdinaryOwnPropertyKeys): array-index keys first in
// ascending numeric order, then every other key in first-insertion order.
std::vector<std::size_t> enumerationOrder(const Object& object);

// UTF-8 helpers shared with modules that need JavaScript string semantics on the strings
// this reader produces.
//
// Decodes the code point (or lone surrogate, in WTF-8) that starts at `position`
// (which must be < text.size()), stores it in `codePoint` and returns its byte length.
// An ill-formed sequence decodes as U+FFFD over its maximal subpart, as TextDecoder does
// (never as a Latin-1 byte: a stray 0xA0 is not a no-break space), so arbitrary text can
// be scanned without an exception.
std::size_t decodeUtf8(std::string_view text, std::size_t position, char32_t& codePoint) noexcept;
// Appends `codePoint` as UTF-8 (WTF-8 for a surrogate code point).
void appendUtf8(std::string& out, char32_t codePoint);
// Provider bytes decoded the way the renderer receives them from Response.text() (WHATWG
// UTF-8 decode): a leading BOM is dropped and each maximal ill-formed subpart becomes
// U+FFFD, so one mis-encoded byte in a label cannot reject a whole payload. The result is
// well-formed UTF-8.
std::string decodeUtf8Lossy(std::string_view bytes);

}  // namespace dip::jsonlite
