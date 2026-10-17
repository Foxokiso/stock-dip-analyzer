#pragma once

// dip::oilnews - the classification half of src/utils/oilNews.js (parseOilNews).
//
// This module preserves existing behavior; it is not a trading backtest and makes
// no judgement about headlines. It reproduces, byte for byte, the string rules the
// JavaScript reference applies to text it has already pulled out of an RSS <item>:
//
//   * splitHeadline   - title/source split on the LAST " - " (ASCII hyphen only),
//                       with the 'Source not supplied' fallback;
//   * resolveSource   - a non-empty trimmed <source> element wins over the split;
//   * isHighImpact    - HIGH_IMPACT_RE.test(title.replace(DEESCALATION_PHRASES, ' '));
//   * isSafeLink      - /^https?:\/\//i on the trimmed <link> text;
//   * orderHeadlines  - [...].slice(0, 15).sort(highImpact first, stable).
//
// RSS/XML parsing is deliberately NOT ported. DOMParser, <item>/<title>/<link>/
// <source>/<pubDate> lookup, textContent trimming, link de-duplication and the
// pubDate -> ISO conversion stay in JavaScript/DOM; every function below receives
// the already trimmed text values that layer produces.
//
// Regex semantics are those of ECMAScript without the `u` flag, hand-written
// rather than delegated to std::regex: \w is exactly [A-Za-z0-9_], \b is derived
// from it, and the `i` flag folds ASCII letters only. Text is UTF-8; because the
// patterns are pure ASCII and UTF-8 is self-synchronising, byte-wise matching
// yields the same answers as the UTF-16 reference (non-ASCII code units are
// non-word characters in both). Parity is verified by scripts/verify-native-oilnews.mjs
// against the real parseOilNews() rather than assumed.

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dip::oilnews {

inline constexpr std::string_view kSourceNotSupplied = "Source not supplied";
// parseOilNews keeps the first 15 accepted headlines before ordering them.
inline constexpr std::size_t kMaxHeadlines = 15;

struct SplitTitle {
    std::string title;            // text before the last " - " (the whole title when absent)
    std::string sourceFromTitle;  // text after it, or kSourceNotSupplied
};

// rawTitle is the trimmed <title> text. The separator must start after index 0
// (`separator > 0` in the reference); nothing is re-trimmed around it.
SplitTitle splitHeadline(std::string_view rawTitle);

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

// splitHeadline + resolveSource + isHighImpact for one accepted item.
Classified classifyHeadline(std::string_view rawTitle,
                            std::optional<std::string_view> sourceElementText = std::nullopt);

// Display order for the accepted, de-duplicated headlines (insertion order in):
// the first kMaxHeadlines entries, high-impact first, otherwise stable.
// Returns indices into the input.
std::vector<std::size_t> orderHeadlines(const std::vector<bool>& highImpact);

}  // namespace dip::oilnews
