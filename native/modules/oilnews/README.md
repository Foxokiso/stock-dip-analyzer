# dip::oilnews — headline classification port

Preserves the classification half of `src/utils/oilNews.js` (`parseOilNews`).
This is preservation of existing behavior, not a trading backtest.

Ported rules (see `include/dip/oilnews.hpp`):

- `splitHeadline` — title/source split on the **last** ASCII `" - "`
  (`separator > 0`), fallback source `Source not supplied`.
- `resolveSource` — non-empty trimmed `<source>` text wins over the split.
- `isHighImpact` — `HIGH_IMPACT_RE.test(title.replace(DEESCALATION_PHRASES, ' '))`.
- `isSafeLink` — `/^https?:\/\//i`.
- `orderHeadlines` — first 15 accepted entries, high-impact first, stable.

**RSS parsing stays in JavaScript/DOM.** `DOMParser`, element lookup,
`textContent.trim()`, link de-duplication and `pubDate` → ISO conversion are not
ported; this module takes the already trimmed strings that layer produces.

The two regexes are reproduced by hand with ECMAScript non-`u` semantics
(`\w` = `[A-Za-z0-9_]`, `\b` derived from it, `i` folds ASCII only) instead of
`std::regex`, whose `\w`/`\b` and high-byte handling are locale- and
implementation-dependent. Parity is checked, not assumed.

## Build and compare

```bash
cmake -S native -B artifacts/native-oilnews -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-oilnews --config Release
ctest --test-dir artifacts/native-oilnews -C Release -R oilnews_reference_parity --output-on-failure
```

`scripts/verify-native-oilnews.mjs` drives `oilnews_driver` (line protocol:
`titles`, `links`, `order` modes) and compares it with the real `parseOilNews()`
run through linkedom, exactly as `tests/oilNews.test.js` does. Cases cover every
unit-test phrase, each keyword alternative and its `\w*`/`s?` forms in isolation
and in four casings, near misses, de-escalation phrases alone and adjacent to
keywords, punctuation boundaries, unicode dashes/spaces, `<source>` resolution,
link safety, ordering, and 500 seeded headline compositions.
