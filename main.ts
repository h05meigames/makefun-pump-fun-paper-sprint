// Pump.fun Paper Sprint — entrypoint. The strategy lives in strategy.ts;
// this file only speaks agent-fun/replay/v2 on stdin/stdout via the kit's
// vendored shim. Run by the grader as `node /bot/main.ts` (Node 22).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
