# Finviz futures and market data integrity

The user requests a modern, smooth Stock Dip Analyzer, with a Finviz futures section. Accuracy is priority one; performance and visual quality are priority two. The user explicitly selected Finviz with its delay shown for now. True real-time futures are outside the capability of this source and are not claimed.

## Data contract

- Market views show actual retrieved source data only. Browser mode without desktop IPC shows unavailable states, never mock prices, scores, or headlines.
- Missing, malformed, non-finite, or unknown values remain unavailable rather than becoming zero, a neutral rating, or fabricated history.
- Retrieval time is separate from source quote time. Unknown quote timestamps and contract expiries are explicitly unknown.
- Futures use Finviz's public futures JSON, with the embedded page JSON as a fallback. Preserve native quote units and bond fractions. No dollar sign is applied universally.
- Finviz FAQ specifies a 20-minute futures delay; the current futures footer says 15 minutes. Use the conservative 20-minute disclosure and document the discrepancy. Retrieval never proves quote freshness.
- Failed refreshes retain previous actual data only with cached/stale labels and last successful retrieval time. Superseded requests cannot overwrite newer state. Partial failures are disclosed per quote.
- Finviz remains the primary stock screener with working sector/exclusion filters. Yahoo provides historical analysis and context with separate source attribution.
- Recovery scores are rule-based scores, not calibrated probabilities. The details score always uses the same one-month period and current source quote as the dashboard; display chart range is independent.
- Source-dependent alerts describe only observed technical conditions and cannot claim live execution prices or unmeasured order flow.

## Interface and performance

Use a quiet slate desktop research workspace with ivory typography, mint action accents, amber delay cues, tabular numbers, and solid bordered cards. Preserve existing alternate themes. A two-row header includes active navigation and compact preferences; a Futures route holds overview cards, category filters, real source sparklines, contract/source details, and error states. The dashboard links to this desk.

Background refreshes preserve layout and data. Avoid forced software rendering, full-table updates per ticker, repeated chart script injection, backdrop blur on every default panel, bouncing rows, and unnecessary motion. Support reduced motion, keyboard focus, and narrow screens.

## Verification and delivery

Add regression tests for financial parsing, null/non-finite inputs, daily baseline selection, timestamp provenance, cached failures, and futures schema. Run all tests, lint, renderer production build, and browser checks on desktop/narrow widths using controlled real-source-shaped fixtures. Attempt live source checks separately; label environmental failures honestly. Deliver a reviewable feature branch and draft pull request; no merge or production deployment is required.
