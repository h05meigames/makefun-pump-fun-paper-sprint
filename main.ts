// Pump.fun Paper Sprint — deterministic early-momentum bot (agent-fun/replay/v2).
//
// Idea, in one paragraph: on a 6-hour pump.fun window most new coins spike hard
// and then dump back near where they started (on the kit's dev data the median
// coin's high is +57% over its create price while its last price is flat), so
// the edge is to buy a coin early, while fresh buyers are still pushing it up,
// and to sell it whole on the first of a take-profit, a stop-loss, a trailing
// stop, or a short time limit. One small buy per coin, never a re-entry, and
// at most five coins open at once keeps the worst case far inside the 50%
// max-drawdown guardrail while the bot still cycles through enough coins to
// clear the 20-coin / 0.01 SOL round-trip bar.
//
// Determinism: no clock, no environment, no Math.random. Every decision is a
// pure function of the hello/batch stream, iterated in insertion order, so two
// runs on the same window produce byte-identical action logs. All money math
// is bigint lamports; price ratios are plain float division (IEEE-754, same
// inputs in the same order give the same result every run).
//
// Money, per the competition: capital 10 SOL, max 5 open positions, one buy
// per mint per reply may spend at most 1% of that mint's real SOL reserve,
// round trip costs about 1.25% of size per side in curve fees plus a flat
// 105,000-lamport transaction fee per order, so a round trip needs roughly a
// 3% move to break even. The take-profit (+18%) and stop-loss (-12%) sit well
// outside that cost band.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Target size of one buy, in lamports (0.15 SOL). The 1%-of-real-reserve cap usually binds first. */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n;
/** Smallest buy worth sending: above the 0.01 SOL round-trip bar, with margin. */
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 1000n;
/** A mint must hold at least this much real SOL before a buy is considered. */
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL;
/** Entry needs this many trades seen on the curve. */
const MIN_TRADES = 4;
/** Entry needs this many distinct buying wallets. */
const MIN_BUYERS = 3;
/** Entry needs the price this far above the create price... */
const MIN_RISE = 0.06;
/** ...but not this far above it (do not chase a top). */
const MAX_RISE = 1.0;
/** Entry needs the price this close to the high seen since creation. */
const NEAR_HIGH = 0.9;
/** Entry window: slots after the CreateEvent during which a buy is allowed. */
const MAX_ENTRY_AGE_SLOTS = 7200;
/** Sell everything at this value/cost ratio or better. */
const TAKE_PROFIT = 1.18;
/** Sell everything at this value/cost ratio or worse. */
const STOP_LOSS = 0.88;
/** Once a position has reached this value/cost ratio, the trailing stop arms. */
const TRAIL_ARM = 1.1;
/** Armed trailing stop: sell when value falls this far below its peak. */
const TRAIL_GIVEBACK = 0.9;
/** Sell everything this many slots after the buy fill, whatever the price. */
const MAX_HOLD_SLOTS = 900;
/** Buy slippage allowance (bps). Sells always go out wide open. */
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------------ per-mint tape

interface Tape {
  createdSlot: number;
  firstPrice: number;
  highPrice: number;
  trades: number;
  buys: number;
  buySolLamports: number;
  sellSolLamports: number;
  buyers: Set<string>;
  lastIsBuy: boolean;
  complete: boolean;
}

interface Held {
  buySlot: number;
  peakRatio: number;
}

/** Price in lamports of SOL per token, from virtual reserves. 0 when unknown. */
function priceOf(curve: Curve | undefined): number {
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

// ------------------------------------------------------------------ bot state

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Mints we already bought (one buy per mint, ever). */
const bought = new Set<Pubkey>();
/** Mints with a completed round trip (a buy fill plus a later sell fill). */
const roundTripped = new Set<Pubkey>();
/** Mints with a buy order sent and not yet resolved. */
const buyInFlight = new Set<Pubkey>();

function foldFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side === 'buy') {
      buyInFlight.delete(fill.mint);
      if (fill.status === 'filled') {
        bought.add(fill.mint);
        held.set(fill.mint, { buySlot: fill.slot, peakRatio: 1 });
      }
    } else if (fill.side === 'sell' && fill.status === 'filled') {
      held.delete(fill.mint);
      if (bought.has(fill.mint)) roundTripped.add(fill.mint);
    }
  }
}

function foldEvents(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const curve = state.curves.get(e.mint);
      tapes.set(e.mint, {
        createdSlot: e.slot,
        firstPrice: priceOf(curve),
        highPrice: priceOf(curve),
        trades: 0,
        buys: 0,
        buySolLamports: 0,
        sellSolLamports: 0,
        buyers: new Set<string>(),
        lastIsBuy: false,
        complete: false,
      });
    } else if (e.event === 'TradeEvent') {
      let tape = tapes.get(e.mint);
      if (tape === undefined) {
        tape = {
          createdSlot: e.slot,
          firstPrice: priceOf(state.curves.get(e.mint)),
          highPrice: priceOf(state.curves.get(e.mint)),
          trades: 0,
          buys: 0,
          buySolLamports: 0,
          sellSolLamports: 0,
          buyers: new Set<string>(),
          lastIsBuy: false,
          complete: false,
        };
        tapes.set(e.mint, tape);
      }
      const price = priceOf(state.curves.get(e.mint));
      if (price > tape.highPrice) tape.highPrice = price;
      tape.trades += 1;
      tape.lastIsBuy = e.is_buy;
      const sol = Number(BigInt(e.sol_amount));
      if (e.is_buy) {
        tape.buys += 1;
        tape.buySolLamports += sol;
        tape.buyers.add(e.user);
      } else {
        tape.sellSolLamports += sol;
      }
    } else {
      const tape = tapes.get(e.mint);
      if (tape !== undefined) tape.complete = true;
    }
  }
}

/** True when this mint is a fresh momentum candidate right now. */
function entrySignal(state: BotState, mint: Pubkey): boolean {
  const tape = tapes.get(mint);
  if (tape === undefined || tape.complete) return false;
  if (bought.has(mint) || buyInFlight.has(mint)) return false;
  if (state.positions.has(mint)) return false;
  if (batchSlotAge(state, tape) > MAX_ENTRY_AGE_SLOTS) return false;
  if (tape.trades < MIN_TRADES || tape.buys < MIN_TRADES) return false;
  if (tape.buyers.size < MIN_BUYERS) return false;
  if (!tape.lastIsBuy) return false;
  // Net SOL must still be flowing in: buys outweigh sells on the tape.
  if (tape.buySolLamports <= tape.sellSolLamports) return false;
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) return false;
  const price = priceOf(curve);
  if (tape.firstPrice <= 0 || price <= 0) return false;
  const rise = price / tape.firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (tape.highPrice <= 0 || price < tape.highPrice * NEAR_HIGH) return false;
  return true;
}

function batchSlotAge(state: BotState, tape: Tape): number {
  return state.slot - tape.createdSlot;
}

await runBot({
  onBatch(state, batch) {
    foldFills(state, batch);
    foldEvents(state, batch);

    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // 1. Exits first: every held position is checked against take-profit,
    // stop-loss, trailing stop, and the time limit. A position sells whole.
    for (const [mint, holding] of state.positions) {
      const info = held.get(mint);
      if (info === undefined) continue;
      const curve = state.curves.get(mint);
      const price = priceOf(curve);
      if (price <= 0) continue;
      const valueLamports = Number(holding.token_amount) * price;
      const cost = Number(holding.cost_lamports);
      if (cost <= 0) continue;
      const ratio = valueLamports / cost;
      if (ratio > info.peakRatio) info.peakRatio = ratio;
      const heldSlots = batch.slot - info.buySlot;
      const takeProfit = ratio >= TAKE_PROFIT;
      const stopLoss = ratio <= STOP_LOSS;
      const trailing =
        info.peakRatio >= TRAIL_ARM && ratio <= info.peakRatio * TRAIL_GIVEBACK;
      const timedOut = heldSlots >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || timedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 2. Entries: mints with an event in this batch, in batch order, while
    // an open-position slot, cash, and the per-reply order cap all allow it.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    // Sells above already free a slot once they fill, but not yet: count only
    // what is open now, which is what the harness enforces.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (!entrySignal(state, e.mint)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      buyInFlight.add(e.mint);
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },

  onDone(state) {
    console.error(
      `done: distinct round-tripped mints=${roundTripped.size} bought=${bought.size}`,
    );
  },
});
