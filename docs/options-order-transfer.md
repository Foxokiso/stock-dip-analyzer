# Options order transfer: Robinhood Legend and Fidelity Trader+ Web

The Options desk builds an order and puts it on the clipboard with **Copy Order Ticket**. The goal of this milestone is one copy and one paste: paste once into a blank broker options ticket and have every leg and order term filled in, ready to review. The analyzer links no brokerage account; account selection, sign-in and submission stay with the broker.

## Status (2026-11-15)

| | Robinhood Legend | Fidelity Trader+ Web |
|---|---|---|
| Analyzer side (build, analyse, copy) | Passes: automated in `scripts/verify-ui.mjs` | Passes: automated in `scripts/verify-ui.mjs` |
| Native paste into the broker's ticket | **Not tested** | **Not tested** |
| Broker-supported prefill link | None found in public documentation | None found in public documentation |
| Browser helper | Not built: the native-paste result decides whether one is needed | Not built |

The broker half has not been run. It needs a signed-in brokerage session with options approval, which only the account holder has, so nothing in this repository claims that either ticket accepts the paste. Neither broker documents a paste or import format for its options ticket, and neither documents a link that prefills one, so the expected result of a plain paste is that the ticket does not populate. That expectation is a guess until the test below is run.

## What is on the clipboard

Plain text, one field per line, in the chosen broker's vocabulary, then one machine-readable line with the same order:

```
ORDER TICKET · Fidelity Trader+ Web options ticket · review before placing
Underlying: AAPL
Strategy: Vertical call spread · 2 × (1:1) · one multi-leg order
Leg 1: Buy to Open 2 AAPL Dec 18 2026 350 Call [-AAPL261218C350]
Leg 2: Sell to Open 2 AAPL Dec 18 2026 360 Call [-AAPL261218C360]
Order type: Net debit limit
Limit price: 1.25
Time in force: Day
Total debit before fees: $250.00
Account, sign-in and submission: in the broker.
DDS-TICKET/1 {"broker":"fidelity","underlying":"AAPL","quantity":2,"orderType":"limit","limit":1.25,"priceSide":"debit","tif":"day","legs":[…]}
```

The Robinhood ticket differs in its wording ("Good for day") and names each contract by its OCC symbol (`AAPL261218C00350000`). The `DDS-TICKET/1` line exists so that a helper, if one turns out to be needed, reads the order from the paste itself and never from the page or an account.

## The test, per broker

Run it once on each broker, separately. Stop at the broker's review screen; never submit.

1. In the analyzer, open **Options**, load a ticker, and build the order. Choose the broker beside **Copy Order Ticket**.
2. **Single leg.** One contract leg, a limit price, Day. Click **Copy Order Ticket**.
3. In the signed-in browser, open a blank options ticket (Robinhood Legend: the options order ticket; Fidelity Trader+ Web: the trade ticket set to options). Click into the ticket's first field and paste once.
4. In the analyzer, open **Check the pasted ticket** and record, for every line, *Matches*, *Differs* (type what the broker showed) or *Not filled*. **Copy transfer check** copies the result.
5. **Two-leg vertical.** Buy one call and sell a higher-strike call of the same expiration, strategy quantity **2**, limit **1.25**, net debit. The analyzer must show **$250.00** total debit before fees. Copy, paste once into a blank ticket, and check again. The broker ticket must show 2 contracts on each leg, Buy on the lower strike and Sell on the higher, one multi-leg order, and a 1.25 limit.

Record for each broker: which ticket, what the paste did (nothing, text landed in one field, some fields filled), every field that needed manual entry, and any default the broker applied that conflicts with the order (for example a different time in force, a market order type, a quantity of 1, or legs split into separate orders).

## What happens next

- **The paste fills the ticket:** done for that broker; record the ticket and browser version here.
- **The paste does not fill it:** the result says what the ticket accepted. The next account-free option is an optional browser helper that runs only on the broker's ticket page, wakes only on a paste that carries a `DDS-TICKET/1` line, fills the ticket's own fields from it and stops before review. It would need the ticket's real field structure, which is why it waits for this test.
