// Preservation of src/utils/oilNews.js classification behavior; not a trading backtest.
#include "dip/oilnews.hpp"

#include <algorithm>
#include <numeric>

namespace dip::oilnews {
namespace {

// ECMAScript (no `u` flag): \w is [A-Za-z0-9_]; the `i` flag folds ASCII letters only.
constexpr bool isWordChar(char c) {
    const unsigned char u = static_cast<unsigned char>(c);
    return (u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z') || (u >= '0' && u <= '9') || u == '_';
}

constexpr char fold(char c) {
    const unsigned char u = static_cast<unsigned char>(c);
    return (u >= 'A' && u <= 'Z') ? static_cast<char>(u - 'A' + 'a') : c;
}

// Case-insensitive match of a lowercase ASCII literal starting at `pos`.
bool literalAt(std::string_view text, std::size_t pos, std::string_view literal) {
    if (pos > text.size() || literal.size() > text.size() - pos) return false;
    for (std::size_t i = 0; i < literal.size(); ++i) {
        if (fold(text[pos + i]) != literal[i]) return false;
    }
    return true;
}

// \b between pos-1 and pos.
bool boundaryAt(std::string_view text, std::size_t pos) {
    const bool before = pos > 0 && pos <= text.size() && isWordChar(text[pos - 1]);
    const bool after = pos < text.size() && isWordChar(text[pos]);
    return before != after;
}

// Length of the greedy \w* run starting at pos.
std::size_t wordRun(std::string_view text, std::size_t pos) {
    std::size_t end = pos;
    while (end < text.size() && isWordChar(text[end])) ++end;
    return end - pos;
}

// DEESCALATION_PHRASES =
//   /ceasefire|cease-fire|truce|peace deal|peace talks|de-?escalat\w*|strikes? (a |an )?deal|deal struck|strike price/gi
// Alternatives are tried in pattern order at one position; the first that fits
// wins (they are mutually exclusive here, so the order cannot change a result).
// No \b anchors: phrases match inside longer words, exactly as the reference does.
constexpr std::string_view kDeescalationLiterals[] = {"ceasefire", "cease-fire", "truce", "peace deal", "peace talks"};
constexpr std::string_view kDeescalationStems[] = {"de-escalat", "deescalat"};  // `-?` is greedy: hyphen first
constexpr std::string_view kStrikeHeads[] = {"strikes ", "strike "};           // `s?` is greedy
constexpr std::string_view kStrikeArticles[] = {"a ", "an ", ""};              // `(a |an )?` is greedy
constexpr std::string_view kDeescalationTails[] = {"deal struck", "strike price"};

std::optional<std::size_t> deescalationAt(std::string_view text, std::size_t pos) {
    for (const std::string_view literal : kDeescalationLiterals) {
        if (literalAt(text, pos, literal)) return literal.size();
    }
    for (const std::string_view stem : kDeescalationStems) {
        if (literalAt(text, pos, stem)) return stem.size() + wordRun(text, pos + stem.size());
    }
    for (const std::string_view head : kStrikeHeads) {
        if (!literalAt(text, pos, head)) continue;
        const std::size_t afterHead = pos + head.size();
        for (const std::string_view article : kStrikeArticles) {
            if (literalAt(text, afterHead, article) && literalAt(text, afterHead + article.size(), "deal")) {
                return head.size() + article.size() + 4;
            }
        }
    }
    for (const std::string_view literal : kDeescalationTails) {
        if (literalAt(text, pos, literal)) return literal.size();
    }
    return std::nullopt;
}

// HIGH_IMPACT_RE =
//   /\b(?:hormuz|attack\w*|strikes?|struck|blockade\w*|sanction\w*|seiz\w*|closures?|closed|fires?|explosions?|blasts?|drones?|missiles?|war|escalat\w*|disrupt\w*|halts?|halted|embargo\w*)\b/i
// Only existence matters (`.test`), so alternative order is irrelevant; every
// backtracking choice that could satisfy the trailing \b is enumerated.
constexpr std::string_view kExactWords[] = {"hormuz", "struck", "closed", "war", "halted"};
constexpr std::string_view kStemWords[] = {"attack", "blockade", "sanction", "seiz", "escalat", "disrupt", "embargo"};
constexpr std::string_view kOptionalPlural[] = {"strike", "closure", "fire", "explosion", "blast", "drone", "missile", "halt"};

bool highImpactAt(std::string_view text, std::size_t pos) {
    if (!boundaryAt(text, pos)) return false;
    for (const std::string_view word : kExactWords) {
        if (literalAt(text, pos, word) && boundaryAt(text, pos + word.size())) return true;
    }
    // stem\w*\b: the greedy run stops at a non-word byte or the end, so \b always holds.
    for (const std::string_view stem : kStemWords) {
        if (literalAt(text, pos, stem)) return true;
    }
    for (const std::string_view stem : kOptionalPlural) {
        if (!literalAt(text, pos, stem)) continue;
        const std::size_t end = pos + stem.size();
        if (boundaryAt(text, end)) return true;
        if (end < text.size() && fold(text[end]) == 's' && boundaryAt(text, end + 1)) return true;
    }
    return false;
}

}  // namespace

SplitTitle splitHeadline(std::string_view rawTitle) {
    const std::size_t separator = rawTitle.rfind(" - ");
    if (separator == std::string_view::npos || separator == 0) {
        return {std::string(rawTitle), std::string(kSourceNotSupplied)};
    }
    return {std::string(rawTitle.substr(0, separator)), std::string(rawTitle.substr(separator + 3))};
}

std::string resolveSource(std::optional<std::string_view> sourceElementText, std::string_view rawTitle) {
    if (sourceElementText && !sourceElementText->empty()) return std::string(*sourceElementText);
    return splitHeadline(rawTitle).sourceFromTitle;
}

std::string blankDeescalation(std::string_view title) {
    // String.prototype.replace with a /g pattern: scan left to right, replace each
    // leftmost match with ' ' and resume after it; every match here is non-empty.
    std::string out;
    out.reserve(title.size());
    std::size_t pos = 0;
    while (pos < title.size()) {
        if (const auto length = deescalationAt(title, pos)) {
            out.push_back(' ');
            pos += *length;
        } else {
            out.push_back(title[pos]);
            ++pos;
        }
    }
    return out;
}

bool isHighImpact(std::string_view title) {
    const std::string blanked = blankDeescalation(title);
    for (std::size_t pos = 0; pos < blanked.size(); ++pos) {
        if (highImpactAt(blanked, pos)) return true;
    }
    return false;
}

bool isSafeLink(std::string_view link) {
    return literalAt(link, 0, "https://") || literalAt(link, 0, "http://");
}

Classified classifyHeadline(std::string_view rawTitle, std::optional<std::string_view> sourceElementText) {
    SplitTitle split = splitHeadline(rawTitle);
    const bool highImpact = isHighImpact(split.title);
    std::string source = sourceElementText && !sourceElementText->empty()
        ? std::string(*sourceElementText) : std::move(split.sourceFromTitle);
    return {std::move(split.title), std::move(source), highImpact};
}

std::vector<std::size_t> orderHeadlines(const std::vector<bool>& highImpact) {
    std::vector<std::size_t> order(std::min(highImpact.size(), kMaxHeadlines));
    std::iota(order.begin(), order.end(), std::size_t{0});
    // (a, b) => Number(b.highImpact) - Number(a.highImpact) with a stable sort.
    std::stable_sort(order.begin(), order.end(), [&highImpact](std::size_t a, std::size_t b) {
        return highImpact[a] && !highImpact[b];
    });
    return order;
}

}  // namespace dip::oilnews
