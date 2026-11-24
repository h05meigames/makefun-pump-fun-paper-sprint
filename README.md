# Pump.fun Paper Sprint bot

[![Bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/h05meigames/makefun-pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/h05meigames/makefun-pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic early-momentum paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on [make.fun](https://make.fun/r/0ene8b3q).

## Strategy

On a 6-hour pump.fun window most new coins spike hard and then dump back near
where they started — on the kit's dev data the median coin's high is +57% over
its create price while its last price is flat. So the bot buys a launch in its
first minute, while fresh buyers are still pushing it up, and sells it whole
within a few slots on the first of:

- **take-profit** at +15% over cost,
- **stop-loss** at −12% over cost,
- **trailing stop** (arms at +8%, sells on a 6% giveback from the peak),
- **time limit** of 5 slots after the buy fill,
- **creator dump** — the position is closed at once when the coin's creator sells.

Entries need at least 2 trades from at least 2 distinct buyers, net SOL still
flowing in, the last trade a buy, price within +35% of the create price and
within 10% of the high since creation, at least 0.3 SOL of real reserve, and
the creator must not have sold. One buy per coin, never a re-entry; at most 5
coins open at once; target stake 0.10 SOL per buy (usually capped lower by the
1% reserve rule). Small stakes and fast exits keep the worst case far inside
the 50% max-drawdown guardrail while the bot still cycles through enough coins
to clear the 20-coin minimum bar (683 round trips on the kit's dev data).

## Determinism

No clock, no environment, no `Math.random`. Every decision is a pure function
of the hello/batch stream, iterated in insertion order, so two runs on the same
window produce byte-identical action logs. All money math is bigint lamports.

## Layout

- `main.ts` — the entrypoint; run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the whole strategy, as a `createStrategy()` factory.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored
  byte-identical from `sdk/ts/makefun-bot.ts`.

## License

MIT — see [LICENSE](LICENSE).
