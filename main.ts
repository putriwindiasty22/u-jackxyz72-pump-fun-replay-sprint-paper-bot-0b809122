// Pump.fun Replay Sprint — paper bot.
//
// Strategy: buy accelerating momentum on young bonding curves, pyramid into
// strength, and exit on a stop-loss, a trailing stop, fading flow, or a time
// limit. A pacing probe keeps the run above the guardrail minimums (20 coins
// with >= 0.01 SOL round trips) whenever the main strategy lags its pace.
//
// The bot reads one batch at a time: every curve keeps a short tape of its
// recorded trades, and entries only fire on curves that are old enough to
// have shaken out their launch dump, liquid enough to size into, and showing
// broad, accelerating buy pressure near their recent high.
//
// Deterministic by construction: no clock, no randomness, no environment;
// every iteration is over insertion-ordered maps fed by the batch stream, so
// two runs on the same window produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const LAMPORTS = 1e9;
/** Curve fee the replay charges on top of the tx fee (95 + 30 bps). */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

// --- entry signal -----------------------------------------------------------
/** Entry lookback, in slots. */
const WINDOW = 150;
/** Slots since a curve's CreateEvent before an entry is allowed. */
const MIN_AGE = 900;
/** Net buy SOL (buys minus sells) over the window. */
const MIN_NET_SOL = 2;
/** Buy trades in the window. */
const MIN_BUYS = 8;
/** Distinct buying wallets in the window. */
const MIN_BUYERS = 8;
/** Price now over price at the window start, minus 1: lower and upper bound. */
const MIN_UP = 0.05;
const MAX_UP = 0.8;
/** Price now must be at least this share of the window high. */
const NEAR_HIGH = 0.9;
/** Largest single wallet's share of the window's buy SOL. */
const MAX_BUYER_SHARE = 0.6;
/** Curve real SOL bounds at entry. */
const MIN_RQ_SOL = 1;
const MAX_RQ_SOL = 80;

// --- sizing -----------------------------------------------------------------
/** First buy of a position, in SOL. */
const INITIAL_SOL = 0.08;
/** Each add-on buy, in SOL. */
const ADD_SOL = 0.15;
/** Most SOL into one position in total. */
const STAKE_SOL = 1.2;
/** Smallest buy worth sending (also the guardrail's round-trip floor). */
const MIN_BUY_SOL = 0.01;
/** Slippage on buys (bps); sells always go out wide open. */
const BUY_SLIP_BPS = 2000;
const SELL_SLIP_BPS = 10_000;

// --- exits ------------------------------------------------------------------
/** Sell when the close value falls this far below cost. */
const STOP_LOSS = 0.1;
/** Sell when the close value falls this far below its peak... */
const TRAIL = 0.15;
/** ...once the value has reached cost * (1 + TRAIL_ARM). */
const TRAIL_ARM = 0.05;
/** Exit after this many slots held... */
const MAX_HOLD = 600;
/** ...unless the position is up at least this much. */
const HOLD_IF_UP = 0.25;
/** Exit when net SOL over the fade window falls below this. */
const FADE_WINDOW = 40;
const FADE_NET_SOL = -1;
/** Exit on any single recorded sell of at least this many SOL. */
const BIG_SELL_SOL = 3;
/** Slots to wait after an exit before the same curve may be bought again. */
const COOLDOWN = 120;
/** Most entries per curve over the run. */
const MAX_ENTRIES = 2;
/** Most momentum positions open at once (the rest of the position cap is for probes). */
const MAX_MAIN = 4;
/** Most SOL at cost across all positions at once (a drawdown guard). */
const MAX_EXPOSURE_SOL = 7;

// --- guardrail pacing -------------------------------------------------------
/** The run must end with at least 20 coins and 200 fills; pace toward more. */
const TARGET_COINS = 30;
const TARGET_FILLS = 300;
/** Seconds of block time over which the pace ramps to its full targets. */
const PACE_SECS = 14_400;
/** Probe round-trip size, in SOL. */
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** The bot's own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

/** How far back any tape must be kept, in slots. */
const KEEP = Math.max(WINDOW, FADE_WINDOW) + 5;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Entry signal on a curve's tape at slot `now`, given its real SOL reserves. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  // The most recent trade inside the window: entries only fire while the
  // tape still ends on a buy, never right after a sell prints.
  let lastBuy = false;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
    lastBuy = tr.buy;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (!lastBuy) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  // Accelerating: the newer half of the window must carry at least 1.5x the
  // net inflow of the older half, and be positive on its own.
  if (netNew <= 0 || netNew < 1.5 * netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > MAX_BUYER_SHARE * buySol) return false;
  return true;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === "filled" && !f.client_id.startsWith("_")) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === "TradeEvent") {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: stop-loss, trailing stop, fading flow, big single sell,
    // and the time limit (which does not apply while the position is well up).
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        // A sell already in flight: wait for it. A buy in flight: sell what
        // we hold now anyway.
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // Then entries and pyramid adds.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_MAIN - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = Math.min(INITIAL_SOL, STAKE_SOL);
      } else {
        // Pyramid into strength only: the price stepped up from the last add,
        // the position is not underwater, and net SOL still flows in.
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * 1.02) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
        if (flow(t, now, WINDOW) < 0) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: "buy", mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
