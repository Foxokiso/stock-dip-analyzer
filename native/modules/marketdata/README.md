# dip::marketdata — Yahoo chart/quote normalization

Preserves `getYahooChartPoints`, `getYahooQuote` and `canRaiseTechnicalAlert` from
`src/utils/marketData.js` so a native caller gets exactly the chart points, quote
fields and alert gate the Electron renderer computes. This is preservation of
existing behavior; it is not a trading backtest. The module performs no network
or provider IO, and it never invents a quote, close, change or timestamp: every
value the reference reports as `null` is `std::nullopt` here, and the retrieval
time (`fetchedAt`) stays separate from the source quote time (`quotedAt`).

## What is preserved

- **Chart points** need a positive finite timestamp that is a valid `Date`
  (`|ms| <= 8.64e15`) and a positive finite close; `null`, `NaN`, `0`, negative and
  `Infinity` bars are dropped; points are stable-sorted by timestamp and carry the
  exchange day (`YYYY-MM-DD`).
- **previousClose** selection: `meta.previousClose` first; `chartPreviousClose`
  only when the request range is `1d`; otherwise the **last** bar that is older than
  the quote and on an earlier exchange day. A null close on that bar yields null —
  a missing session must never become a multi-session "day change".
- **quotedAt** is `Date#toISOString` of `regularMarketTime` (milliseconds, time value
  truncated toward zero, years past 9999 written `+YYYYYY`); **delayMinutes** keeps a
  finite value `>= 0` (including `-0`); **currency** / **exchangeTimezone** pass
  through only when they are strings; **changePct** is `(price - prev) / prev * 100`.
- **canRaiseTechnicalAlert**: positive price, `historyLength >= 15`,
  `delayMinutes === 0`, and a parseable `quotedAt` between five minutes ago and now.

## Time zones

The exchange day uses `std::chrono` (`time_zone::get_info`, i.e. `zoned_time`
semantics) with the IANA name Yahoo reports. Zone data comes from the **OS ICU
(`icu.dll`) on Windows/MSVC** and from **tzdata (`/usr/share/zoneinfo`) on
Linux/libstdc++**; the JavaScript reference uses Node's bundled ICU. Like
`Intl.DateTimeFormat`, the lookup ignores case and accepts link names
(`US/Eastern`, `utc`). An unknown zone — or no zone database at all — falls back to
the UTC date exactly like the JavaScript `catch` path
(`toISOString().slice(0, 10)`, so year 275760 prints `+275760-09`). Instants past
year 9999 are folded back by whole 400-year Gregorian cycles before asking the
zone, which keeps 16-bit `std::chrono::year` implementations correct.

`Date.parse` is ported for the ECMAScript date-time format as V8 accepts it
(`T`/`t`/space separators, `Z`/`z`, `±HH:mm`/`±HHmm`, any number of fraction
digits, `24:00`, day overflow such as Feb 30, expanded `±YYYYYY` years). Date-only
forms are UTC; date-time forms without an offset are host-local, using the offset
in force *before* a transition inside a DST gap or overlap (ECMAScript `LocalTZA`,
which `std::chrono::local_info::first` provides). V8's lenient legacy formats
(`"Oct 9 2026"`, `"2026-1-9"`, `"2026-10-09Z"`) are not ported and parse as `NaN`.

## Driver protocol

`tests/marketdata_driver.cpp` reads one case per line and prints one line:

- quote line (no keyword): `regularMarketPrice regularMarketTime exchangeTimezoneName
  range chartPreviousClose previousClose exchangeDataDelayedBy currency | timestamps... |
  closes...` → `price previousClose changePct quotedAt delayMinutes currency
  exchangeTimezone source closes points` (tab-separated; closes comma-terminated,
  points `timestamp,date,price;`)
- `alert <price> <quotedAt> <delayMinutes> <historyLength> <nowMillis>` → `1` | `0`
- `iso <seconds>` → quotedAt | `null`; `day <seconds> <zone>` → `YYYY-MM-DD` | `throws`;
  `parse <text>` → milliseconds | `nan`

Numbers are `null` | `nan` | `Infinity` | `-Infinity` | the `String(x)` literal;
strings are `null` or `s:` + `encodeURIComponent(text)`.

## Build and compare

```bash
cmake -S native -B artifacts/native-marketdata -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-marketdata --config Release
ctest --test-dir artifacts/native-marketdata -C Release -R marketdata_reference_parity --output-on-failure
# or directly:
node scripts/verify-native-marketdata.mjs artifacts/native-marketdata/modules/marketdata/Release/marketdata_driver.exe
```

`scripts/verify-native-marketdata.mjs` imports the real `src/utils/marketData.js`
and compares with relative tolerance `1e-12` for doubles and exact equality for
strings. It covers every case in `tests/marketData.test.js`, object-shape probes,
DST boundaries for America/New_York, Europe/London and Australia/Sydney, Asia/Tokyo,
aliased and lower-case zone names, unknown zones, invalid timestamps, `Infinity`
closes, far-future instants, 300 seeded quote cases, and the `exchangeDay`,
`isoTime` and `Date.parse` building blocks (the last against the engine, as the
format verifier does for `toFixed`).
