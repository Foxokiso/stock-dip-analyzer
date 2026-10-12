# Native C++ scoring core: initial verification

This is a reviewed first slice of native reengineering, not a completed C++
application. The existing frontend still calls the JavaScript scoring engine.
No new market feed, UI feature, or performance improvement is claimed.

## Verified locally

- A deliberate initial stub returned no analysis; the parity test failed on the
  first valid flat-price case. This established that the test detects a missing
  native implementation.
- GCC 13.3 compiled the implementation under C++20 with
  `-Wall -Wextra -Werror -pedantic`; no compiler diagnostics were emitted.
- CMake 3.31.6 configured and built the library/test driver; CTest passed its
  reference-parity test.
- All 528 deterministic native/JavaScript comparisons passed, covering invalid
  bars/quotes, insufficient history, repeated/new peaks, dip-depth thresholds,
  RSI/EMA/score decisions, factor points, verdicts, trend flags and sparklines.
- AddressSanitizer and UndefinedBehaviorSanitizer passed those 528 cases with
  leak detection disabled. The first sanitizer run could not complete because
  LeakSanitizer cannot inspect this environment's process/thread state. No leak
  detection result is claimed.
- `git diff --check` and actionlint validation passed.

## Review and limits

The implementation has no provider IO, global mutable state, UI dependencies or
background threads. Every request uses local values. Insufficient history returns
an optional empty result, and invalid/non-positive price observations are excluded
exactly as in the existing engine. Latest repeated peaks, fixed threshold ordering,
and the existing simple trailing RSI are preserved rather than redesigned.

This API accepts typed numeric data. It does not replace provider JSON validation,
session/timezone logic, source freshness policies or futures parsing. Factor prose,
theme colors and standalone chart SMA series remain to be ported. Cross-language
parity preserves the current algorithm; it does not establish trading correctness
or strategy profitability. Randomized cases are deterministic, bounded price
series; extreme floating-point overflow behavior is not comprehensively tested.

`native-core.yml` is configured to build and run parity tests on Linux and Windows.
Windows/MSVC compilation is pending runner evidence; the Qt frontend, model/thread
integration, real-provider connections, native installer and app launch are all
unimplemented/unverified. The feature inventory and remaining architecture are in
`docs/superpowers/specs/2026-10-12-cpp-native-reengineering.md`.

The current Electron baseline's Windows packaging succeeded in Actions run
38304205901 on commit fa2fe86d1561959a7088a036554c20ff118a6ba7. That installer result
does not validate this native C++ core or a future Qt application. Neither branch
is authorized for merge or publication.
