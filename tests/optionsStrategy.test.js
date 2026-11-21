import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFinvizOptionsPage } from '../src/utils/finvizOptions.js';
import { analyzeOrder, fidelitySymbol, marketNet, occSymbol, orderProblems, strategyName, suggestedSide, ticketFields, ticketText } from '../src/utils/optionsStrategy.js';

const chain = parseFinvizOptionsPage(readFileSync(new URL('./fixtures/finviz-options-AAPL-2026-12-18.html', import.meta.url), 'utf8'));
const contract = (type, strike) => chain.strikes.find(row => row.strike === strike)[type];
const leg = (action, type, strike, changes = {}) => ({ contract: contract(type, strike), action, effect: 'open', ratio: 1, ...changes });
const order = (legs, changes = {}) => ({ symbol: 'AAPL', legs, quantity: 1, orderType: 'limit', limit: null, priceSide: 'debit', tif: 'day', ...changes });
// The acceptance case: two standard vertical call spreads at a $1.25 net debit.
const spread = order([leg('buy', 'call', 350), leg('sell', 'call', 360)], { quantity: 2, limit: 1.25 });

test('two vertical spreads at a 1.25 net debit cost $250 before fees', () => {
    const analysis = analyzeOrder(spread, chain.underlying);
    assert.equal(analysis.strategy, 'Vertical call spread');
    assert.equal(analysis.total, 250);
    assert.equal(analysis.side, 'debit');
    assert.equal(analysis.maxLoss, 250);
    assert.equal(analysis.maxGain, 1750, '(10 wide - 1.25) x 100 x 2');
    assert.deepEqual(analysis.breakevens, [351.25]);
    assert.equal(analysis.strikeWidth, 10);
    assert.deepEqual(analysis.notes, []);
    // The chart passes through its own figures.
    const at = (target) => analysis.payoff.find(point => point.price === target).pnl;
    assert.deepEqual([at(350), at(351.25), at(360)], [-250, 0, 1750]);
    assert.equal(analysis.payoff[0].pnl, -250);
    assert.equal(analysis.payoff.at(-1).pnl, 1750);
});

test('the ticket carries every leg and term, with two contracts on each leg', () => {
    for (const broker of ['robinhood', 'fidelity']) {
        const fields = Object.fromEntries(ticketFields(spread, broker).map(field => [field.key, field.value]));
        assert.equal(fields.underlying, 'AAPL');
        assert.deepEqual([fields['leg1.action'].toLowerCase(), fields['leg1.quantity'], fields['leg1.expiration'], fields['leg1.strike'], fields['leg1.type']], ['buy to open', '2', 'Dec 18 2026', '350', 'Call']);
        assert.deepEqual([fields['leg2.action'].toLowerCase(), fields['leg2.quantity'], fields['leg2.expiration'], fields['leg2.strike'], fields['leg2.type']], ['sell to open', '2', 'Dec 18 2026', '360', 'Call']);
        assert.deepEqual([fields.ratio, fields.quantity, fields.orderType, fields.limit], ['1 : 1', '2', 'Net debit limit', '1.25']);
        assert.match(fields.single, /one multi-leg order/);

        const text = ticketText(spread, broker, analyzeOrder(spread));
        assert.match(text, /^ORDER TICKET · .* · review before placing\nUnderlying: AAPL\n/);
        assert.match(text, /Leg 1: Buy to open 2 AAPL Dec 18 2026 350 Call \[/i);
        assert.match(text, /Leg 2: Sell to open 2 AAPL Dec 18 2026 360 Call \[/i);
        assert.match(text, /\nLimit price: 1\.25\n/);
        assert.match(text, /\nTotal debit before fees: \$250\.00\n/);
        const machine = JSON.parse(text.split('\n').at(-1).replace(/^DDS-TICKET\/1 /, ''));
        assert.deepEqual(machine, {
            broker, underlying: 'AAPL', quantity: 2, orderType: 'limit', limit: 1.25, priceSide: 'debit', tif: 'day',
            legs: [
                { action: 'buy', effect: 'open', ratio: 1, contracts: 2, type: 'call', strike: 350, expiration: '2026-12-18', occ: 'AAPL261218C00350000' },
                { action: 'sell', effect: 'open', ratio: 1, contracts: 2, type: 'call', strike: 360, expiration: '2026-12-18', occ: 'AAPL261218C00360000' },
            ],
        });
    }
    assert.match(ticketText(spread, 'fidelity', analyzeOrder(spread)), /\[-AAPL261218C350\]/);
    assert.match(ticketText(spread, 'robinhood', analyzeOrder(spread)), /Time in force: Good for day/);
    assert.match(ticketText({ ...spread, tif: 'gtc' }, 'fidelity', analyzeOrder(spread)), /Time in force: Good 'til Canceled \(GTC\)/);
});

test('a single long call: limit order, unlimited gain, loss limited to the debit', () => {
    const single = order([leg('buy', 'call', 360)], { quantity: 3, limit: 8.4 });
    const analysis = analyzeOrder(single);
    assert.deepEqual([analysis.strategy, analysis.total, analysis.side, analysis.maxLoss, analysis.maxGain], ['Long call', 2520, 'debit', 2520, Infinity]);
    assert.deepEqual(analysis.breakevens, [368.4]);
    const fields = Object.fromEntries(ticketFields(single, 'fidelity').map(field => [field.key, field.value]));
    assert.deepEqual([fields['leg1.action'], fields['leg1.quantity'], fields.orderType, fields.limit, fields.tif], ['Buy to Open', '3', 'Limit', '8.40', 'Day']);
    assert.equal(fields.ratio, undefined, 'a single leg has no ratio or strategy quantity field');
});

test('credits, short options and ratios', () => {
    const shortPut = analyzeOrder(order([leg('sell', 'put', 350)], { limit: 6, priceSide: 'credit' }));
    assert.deepEqual([shortPut.side, shortPut.total, shortPut.maxGain, shortPut.maxLoss], ['credit', 600, 600, 34400]);
    assert.deepEqual(shortPut.breakevens, [344]);

    const shortCall = analyzeOrder(order([leg('sell', 'call', 360)], { limit: 8, priceSide: 'credit' }));
    assert.deepEqual([shortCall.maxGain, shortCall.maxLoss], [800, Infinity]);
    assert.deepEqual(shortCall.breakevens, [368]);

    // 1 x 2 ratio spread for a 1.00 credit: a net short call above 360.
    const ratio = order([leg('buy', 'call', 350), leg('sell', 'call', 360, { ratio: 2 })], { quantity: 3, limit: 1, priceSide: 'credit' });
    const analysis = analyzeOrder(ratio);
    assert.deepEqual([analysis.strategy, analysis.total, analysis.maxGain, analysis.maxLoss], ['Custom 2-leg strategy', 300, 3300, Infinity]);
    assert.deepEqual(analysis.breakevens, [371]);
    assert.deepEqual(ticketFields(ratio, 'robinhood').filter(field => /quantity$|^ratio$/.test(field.key)).map(field => field.value), ['3', '6', '1 : 2', '3']);

    const straddle = analyzeOrder(order([leg('buy', 'call', 355), leg('buy', 'put', 355)], { limit: 20 }));
    assert.deepEqual([straddle.strategy, straddle.maxLoss, straddle.maxGain], ['Long straddle', 2000, Infinity]);
    assert.deepEqual(straddle.breakevens, [335, 375]);
});

test('the market price is read from the quotes and never replaces the chosen limit', () => {
    const { legs } = spread;
    assert.deepEqual(marketNet(legs), { mid: 5.85, natural: 6.3 });
    assert.equal(suggestedSide(legs), 'debit');
    assert.equal(suggestedSide([legs[1]]), 'credit');
    // Fresh quotes: the same order analysed against moved contracts keeps its 1.25.
    const moved = legs.map(item => ({ ...item, contract: { ...item.contract, bid: item.contract.bid + 3, ask: item.contract.ask + 3, mid: item.contract.mid + 3 } }));
    const analysis = analyzeOrder({ ...spread, legs: moved });
    assert.deepEqual([analysis.entry, analysis.total], [1.25, 250]);
    // A leg without a quote has no market price, and nothing is invented.
    assert.deepEqual(marketNet([{ ...legs[0], contract: { ...legs[0].contract, mid: null, ask: null } }]), { mid: null, natural: null });
});

test('figures that cannot be defined are absent, with the reason', () => {
    const noLimit = analyzeOrder({ ...spread, limit: null });
    assert.deepEqual([noLimit.total, noLimit.maxLoss, noLimit.payoff], [null, null, null]);
    assert.match(noLimit.notes[0], /Enter a limit price/);

    const market = analyzeOrder(order([leg('buy', 'call', 360)], { orderType: 'market' }));
    assert.deepEqual([market.total, market.estimated], [840, true]);
    assert.match(market.notes[0], /estimated at the midpoint/);

    const calendar = analyzeOrder(order([leg('sell', 'call', 360), { ...leg('buy', 'call', 360), contract: { ...contract('call', 360), id: '2027-01-15|call|360', expiry: '2027-01-15' } }], { limit: 2 }));
    assert.deepEqual([calendar.strategy, calendar.total, calendar.maxLoss, calendar.breakevens], ['Calendar call spread', 200, null, null]);
    assert.match(calendar.notes.join(' '), /different days/);

    assert.match(analyzeOrder(order([leg('sell', 'call', 360, { effect: 'close' })], { limit: 8, priceSide: 'credit' })).notes[0], /Closing legs/);
});

test('an incomplete order names what is missing', () => {
    assert.deepEqual(orderProblems(spread), []);
    assert.match(orderProblems(order([]))[0], /Add at least one leg/);
    assert.match(orderProblems({ ...spread, limit: 0 })[0], /limit price above 0/);
    assert.match(orderProblems({ ...spread, quantity: 1.5 })[0], /whole number/);
    assert.match(orderProblems({ ...spread, orderType: 'market' })[0], /need a limit price/);
    assert.match(orderProblems(order([leg('buy', 'call', 350), leg('sell', 'call', 350)], { limit: 1 }))[0], /same contract/);
    assert.match(orderProblems(order([335, 340, 345, 350, 355].map(strike => leg('buy', 'call', strike)), { limit: 1 }))[0], /at most 4 legs/);
});

test('option symbols and strategy names', () => {
    assert.equal(occSymbol('aapl', contract('put', 345)), 'AAPL261218P00345000');
    assert.equal(occSymbol('F', { expiry: '2027-01-15', type: 'call', strike: 12.5 }), 'F270115C00012500');
    assert.equal(fidelitySymbol('F', { expiry: '2027-01-15', type: 'call', strike: 12.5 }), '-F270115C12.5');
    // A share class keeps no punctuation in the option root (BRK-B trades options as BRKB).
    for (const spelled of ['BRK-B', 'brk.b']) {
        assert.equal(occSymbol(spelled, { expiry: '2026-12-18', type: 'call', strike: 500 }), 'BRKB261218C00500000');
        assert.equal(fidelitySymbol(spelled, { expiry: '2026-12-18', type: 'call', strike: 500 }), '-BRKB261218C500');
    }
    assert.equal(strategyName([leg('sell', 'put', 350)]), 'Short put');
    assert.equal(strategyName([leg('sell', 'put', 350), leg('buy', 'put', 340)]), 'Vertical put spread');
    assert.equal(strategyName([leg('sell', 'call', 365), leg('sell', 'put', 345)]), 'Short strangle');
});
