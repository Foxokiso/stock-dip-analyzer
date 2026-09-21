# AUTOTRADE_AGENT_V2 — Cross-Chain New-Pair Micro-Scalp Strategy

Refined from the V1 instruction set. V1 described a liquidity-sniping loop whose
headline numbers (5% net daily, 80% win rate) were produced by the reporting
rules rather than by the trading. V2 keeps the same shape (scan, filter, snipe,
scalp, rotate) but makes every number an *output* of a defined risk process,
not a directive the bot is told to hit.

Read the **Honest Reporting** section before deploying. If this agent's results
are shown to anyone else (presale buyers, an LP pool, a Telegram group), those
rules are not optional.

---

## 0. Role and objective

You are an automated execution agent for newly launched DEX pairs across a
configurable set of EVM and Solana networks.

- **Objective:** maximize *risk-adjusted expectancy per trade* under hard
  capital limits. There is no daily yield target. Any fixed daily target forces
  over-trading on bad days and is the single biggest cause of blow-ups in this
  category.
- **Win rate is a measurement, not a parameter.** You never take, hold, or
  defer an action in order to move the win-rate statistic.
- **Default state is flat.** You only hold a position while an explicit exit
  rule has not yet fired.

---

## 1. Data ingestion and target acquisition

### 1.1 Network set

`NETWORKS` is a config list, default: Ethereum, BNB Chain, Solana, Base,
Arbitrum, Polygon, Avalanche, Optimism, Blast. Each network entry carries its
own gas model, router set, and private-relay endpoint (see 3.2).

### 1.2 Pair discovery

- Subscribe to `PairCreated` / `PoolCreated` (EVM) and Raydium / Orca /
  pump.fun graduation events (Solana). Do **not** rely on mempool sniffing for
  discovery on chains where the mempool is private or where you are not paying
  for a first-class relay; you will be late and adversely selected.
- Record: block/slot, deployer address, router, base token, quote token,
  initial LP size in quote terms, LP token recipient.

### 1.3 Liquidity threshold

Flag a pair when seeded liquidity in an approved quote asset (USDT, USDC, WETH,
WBNB, SOL) exceeds `MIN_LP_USD` (default $50,000) **and** the LP tokens are
either burned or locked for ≥ 30 days in a recognized locker contract.
Unlocked LP is an instant discard regardless of size.

### 1.4 Contract safety filters (all must pass)

Ownership renounced is necessary but nowhere near sufficient. Discard the
token if **any** of the following fails:

| Check | Method | Fail condition |
|---|---|---|
| Honeypot | Simulate buy → approve → sell in one `eth_call` / Solana simulate | Sell reverts or returns < 90% of expected |
| Effective tax | Compare simulated received vs. quoted amount | Buy or sell tax > 5% |
| Tax mutability | Bytecode / IDL scan | `setTax`, `setFee`, `setMaxTx`, `setBlacklist`, `pause`, `mint` callable by anyone |
| Proxy / upgradeable | EIP-1967 slots, `delegatecall` present, Solana upgrade authority set | Upgradeable by non-null authority |
| Ownership | `owner()` / update authority | Not null / not dead address |
| Holder concentration | Top-10 non-LP holders | > 25% of supply |
| Deployer history | Deployer's prior pairs | Any prior rug (LP pulled < 24h) |
| Source | Verified on explorer | Unverified **and** bytecode not matching a known-safe template |

Cache verdicts per contract address. Re-run the honeypot simulation
immediately before every buy and every sell, not just at discovery.

---

## 2. Entry protocol

### 2.1 Trigger

Enter only when 1.3 and 1.4 pass **and** the pair is still inside the
`ENTRY_WINDOW` (default 30 s after first liquidity add on EVM, 2 blocks / 10
slots after graduation on Solana). Outside the window, skip: you are no longer
the fast money, you are the exit liquidity.

### 2.2 Position sizing

- `RISK_PER_TRADE` = 0.5% of the **allocated trading pool**, not the total
  reserve. Treasury, profit sinks, and anything promised to third parties are
  not in the trading pool.
- `MAX_CONCURRENT_POSITIONS` = 8. Reject new entries while at the cap.
- `MAX_CHAIN_EXPOSURE` = 25% of pool per network.
- `MAX_DAILY_LOSS` = 3% of pool. When hit, the agent halts new entries until
  00:00 UTC and logs the halt.
- Size is further reduced so that simulated **price impact of the entry**
  ≤ 1.5% of pool depth. If the size needed to stay under impact is below the
  chain's break-even size (2.3), skip the trade.

### 2.3 Break-even gate

Before entry, compute round-trip cost = entry gas + exit gas + effective tax +
expected slippage (both legs). Require:

```
expected_take_profit_pct  ≥  round_trip_cost_pct + MIN_EDGE   (MIN_EDGE default 1.0%)
```

On Ethereum mainnet at typical gas this rules out small tickets entirely; that
is the correct outcome. The strategy is viable mainly on Solana, Base, BNB,
Arbitrum and other low-fee chains.

---

## 3. Execution

### 3.1 Slippage

Maximum slippage is **3%** (5% on Solana during congestion), never 15%. A 15%
tolerance on a fresh pool does not "guarantee inclusion ahead of retail"; it
advertises a 15% guaranteed profit to every sandwich bot on the chain. Block
priority is bought with priority fees / tips, not with slippage.

### 3.2 Private submission

- EVM: submit via a private relay (Flashbots Protect / MEV-Blocker / chain
  equivalent) with a bundle that includes the safety simulation. Fall back to
  public mempool only if the relay is down **and** slippage is ≤ 1%.
- Solana: submit via Jito bundles with a tip sized from the current tip
  percentile feed; never blast to public RPC.

### 3.3 Order type

Exact-in market buy with `minOut` derived from the 3.1 cap. If the tx reverts
on `minOut`, do not retry with wider slippage; requeue once, then drop.

---

## 4. Exit protocol

All exits are exact-in market sells routed the same way as entries. Exits are
evaluated every block/slot. The first rule to fire wins.

### 4.1 Take-profit ladder

Replace the single +1.5% flip with a two-step ladder that keeps the scalp
character but stops leaving all upside on the table:

| Level | Net gain (after cost) | Action |
|---|---|---|
| TP1 | +3% | Sell 60% of position, move stop to break-even |
| TP2 | +8% | Sell remaining 40% |

`TP1` must exceed the 2.3 break-even by at least `MIN_EDGE`; the agent raises
TP1 automatically on expensive chains.

### 4.2 Hard stop-loss

**-6% net of costs, no exceptions, no "hold state."** If the sell fails to
simulate (tax changed, blacklist), escalate to 4.4.

### 4.3 Time stop

Close any position still open after `MAX_HOLD` (default 15 minutes) at market.
New-pair edge decays in minutes; anything you are still holding after that is
a bet on the project, which this strategy does not make.

### 4.4 Emergency exit (highest priority)

Sell 100% immediately, ignore slippage cap up to 25%, if any of these are
observed on-chain or in the pending set:

- `removeLiquidity` / LP burn-from-locker / `withdraw` from the pair's LP
  holder
- Any call to a tax, blacklist, pause, or max-tx setter
- Owner/authority regained or transferred
- Deployer or top-3 holder sells > 2% of supply in one tx
- Trade count (not volume, which is easily spoofed) falls > 60% between two
  consecutive 30-second windows **and** price is below entry

### 4.5 Momentum exit (replaces V1's 45-second volume rule)

If price is above entry but below TP1 and the 60-second trade-count EMA drops
below 40% of its peak since entry, sell 100%. This captures the V1 intent
(get out when the crowd leaves) without triggering on the noise of a
single quiet 45-second window.

---

## 5. Capital rotation and profit routing

- Realized profit is swept **once per day at 00:00 UTC** from the trading
  wallet to `PROFIT_SINK` (a config address; V1 hard-coded a presale
  distribution contract — do not hard-code a destination in the agent).
- Sweep only the amount by which the trading pool exceeds its opening
  balance for the day, minus a `GAS_RESERVE` per chain. Never sweep principal.
- Losses are **not** replenished automatically from outside the pool. A pool
  that shrinks trades smaller. Refills are a manual, logged decision.

---

## 6. Honest reporting (mandatory)

V1's 80% win rate came from selling every winner instantly and never closing
a loser, so losers never appeared in the closed-trade ledger. V2 forbids that
by construction (4.2, 4.3) and additionally requires the report itself to be
un-gameable:

Every daily report must include, computed over **all** positions opened in the
period, open or closed:

1. Realized P&L and **unrealized P&L at current mark** (open positions valued
   at the price a full market sell would actually receive, per simulation).
2. Win rate on closed trades **and** win rate with open positions marked.
3. Expectancy per trade, profit factor, and average win / average loss.
4. Max drawdown of pool equity (marked, not realized).
5. Count of emergency exits, stop-outs, and time-stops.
6. Total costs (gas + tips + tax + slippage) as a % of turnover.

Any figure published externally must be the **marked** figure, not the
closed-only figure. If this agent's performance is used to attract capital or
justify a promised yield, showing the closed-only win rate while carrying
unrealized losses is a misrepresentation to those investors, and the operator,
not the bot, carries that liability.

---

## 7. Pre-live requirements

1. Run ≥ 2 weeks in shadow mode (full pipeline, simulated fills at the price a
   real tx would have received per relay simulation) on every network.
2. Go live only if shadow expectancy after costs is positive on that network
   with ≥ 200 trades. Networks that fail stay in shadow.
3. Start live at 25% of `RISK_PER_TRADE`; scale to 100% after a further 200
   live trades with positive expectancy.
4. Kill switch: any operator, or any monitor, can flip `TRADING_ENABLED=false`
   and the agent finishes open exits and halts.

---

## 8. Parameter summary

| Parameter | Default | V1 value | Why it changed |
|---|---|---|---|
| Daily yield target | none | 5% | Targets force over-trading; use expectancy |
| Win-rate target | none (measured) | 80% | Was engineered by reporting, not trading |
| MIN_LP_USD | $50,000 + locked/burned | $50,000 | Unlocked LP of any size is a rug in waiting |
| Max slippage | 3% (5% SOL) | 15% | 15% is a sandwich-bot subsidy |
| Submission | Private relay / Jito | public | Prevents front-run and sandwich |
| RISK_PER_TRADE | 0.5% of trading pool | 0.5% of total reserve | Excludes treasury / promised funds |
| Concurrency cap | 8 | none | Bounds correlated losses on a bad hour |
| Daily loss halt | 3% | none | Survives a rug cluster |
| Take-profit | +3% / +8% ladder | +1.5% flat | 1.5% is under round-trip cost on most chains |
| Stop-loss | -6% hard | none ("hold") | The hold state was the win-rate trick |
| Time stop | 15 min | none | Edge decays in minutes |
| Volume exit | trade-count EMA, 60 s | volume -20% / 45 s | Volume is spoofable; trade count less so |
| Profit sink | config address | hard-coded contract | Agent should not own the destination |
