#pragma once

// dip::oilnews - the classification half of src/utils/oilNews.js (parseOilNews).
//
// This module preserves existing behavior; it is not a trading backtest and makes
// no judgement about headlines. It reproduces, byte for byte, the string rules the
// JavaScript reference applies to text it has already pulled out of an RSS <item>:
//
//   * titleWithoutSource - with a <source>, only its exact " - <source>" suffix is cut
//                       from the title;
//   * splitHeadline   - without one, title/source split on the LAST " - " (ASCII
//                       hyphen only), with the 'Source not supplied' fallback;
//   * resolveSource   - a non-empty trimmed <source> element wins over the split;
//   * isHighImpact    - HIGH_IMPACT_RE.test(title.replace(DEESCALATION_PHRASES, ' '));
//   * isSafeLink      - /^https?:\/\//i on the trimmed <link> text;
//   * orderHeadlines  - newest first (undated last, stable), the first 15 of those,
//                       then high-impact first (stable).
//
// RSS/XML parsing is deliberately NOT ported. DOMParser, <item>/<title>/<link>/
// <source>/<pubDate> lookup, textContent trimming, link de-duplication and the
// pubDate -> time conversion stay in JavaScript/DOM; every function below receives
// the already trimmed text values (and parsed times) that layer produces.
//
// Regex semantics are those of ECMAScript without the `u` flag, hand-written
// rather than delegated to std::regex: \w is exactly [A-Za-z0-9_], \b is derived
// from it, and the `i` flag folds ASCII letters only. Text is UTF-8; because the
// patterns are pure ASCII and UTF-8 is self-synchronising, byte-wise matching
// yields the same answers as the UTF-16 reference (non-ASCII code units are
// non-word characters in both). Parity is verified by scripts/verify-native-oilnews.mjs
// against the real parseOilNews() rather than assumed.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dip::oilnews {

inline constexpr std::string_view kSourceNotSupplied = "Source not supplied";
// parseOilNews shows the 15 newest accepted headlines.
inline constexpr std::size_t kMaxHeadlines = 15;

struct SplitTitle {
    std::string title;            // text before the last " - " (the whole title when absent)
    std::string sourceFromTitle;  // text after it, or kSourceNotSupplied
};

// rawTitle is the trimmed <title> text. The separator must start after index 0
// (`separator > 0` in the reference); nothing is re-trimmed around it. Used only when
// the item has no non-empty <source>.
SplitTitle splitHeadline(std::string_view rawTitle);

// rawTitle without its exact " - " + source suffix, or the whole of rawTitle when it does
// not end that way (a publisher such as "ABC News - Breaking News" contains " - " itself,
// and a headline may too). source is the non-empty trimmed <source> text.
std::string_view titleWithoutSource(std::string_view rawTitle, std::string_view source);

// sourceElementText is the trimmed <source> text, or nullopt when the element is
// absent. Empty text falls through to the title-derived source (JS `||`).
std::string resolveSource(std::optional<std::string_view> sourceElementText,
                          std::string_view rawTitle);

// title.replace(DEESCALATION_PHRASES, ' '): every match becomes a single space.
std::string blankDeescalation(std::string_view title);

// HIGH_IMPACT_RE.test(blankDeescalation(title)).
bool isHighImpact(std::string_view title);

// /^https?:\/\//i on the trimmed <link> text; unsafe links are dropped upstream.
bool isSafeLink(std::string_view link);

struct Classified {
    std::string title;
    std::string source;
    bool highImpact{};
};

// One accepted item: the publisher is the non-empty <source> text with
// titleWithoutSource for the title, otherwise splitHeadline decides both; then
// isHighImpact on the title.
Classified classifyHeadline(std::string_view rawTitle,
                            std::optional<std::string_view> sourceElementText = std::nullopt);

// What the display order of one accepted headline depends on.
struct HeadlineKey {
    // Date.parse(publishedAt): Unix milliseconds of the <pubDate>; nullopt when it is
    // absent or invalid.
    std::optional<std::int64_t> publishedMs;
    bool highImpact{};
};

// Display order for the accepted, de-duplicated headlines (feed order in). Google News
// ranks search results by relevance, so they are put newest first, undated last and
// equal times in feed order; the first kMaxHeadlines of those are shown, high-impact
// first, each group keeping that order. Returns indices into the input.
std::vector<std::size_t> orderHeadlines(const std::vector<HeadlineKey>& headlines);

}  // namespace dip::oilnews
