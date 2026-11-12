/**
 * The one switch for Robinhood-side Max Loss stops: resting a stop_market on
 * every filled option buy, cancelling it before a sell of that contract, and
 * software Max Loss leaving a stopped position to its stop.
 *
 * Off: no stop is rested, no stop is cancelled or read, a stop id stored on a
 * buy row is ignored, and Max Loss is the software sweep alone, as it was
 * before the stops shipped on 2026-11-09.
 *
 * Why it is off: Robinhood refused every stop cancel ("Order cannot be
 * cancelled at this time"), which blocked every exit of a stopped contract,
 * and three review rounds of the fix each found new interactions in the stop
 * paths. None of them can be tested against Robinhood.
 *
 * Review before turning it on:
 * - what Robinhood really answers for a stop's cancel, its states and its
 *   processed_quantity, checked against real orders;
 * - a stop that died after a partial fill keeps its id and blocks every exit
 *   of that contract;
 * - approving a full pending exit never reaches its lot's stop;
 * - a stale lot is handed contracts that a newer lot's working sell holds;
 * - a stop Robinhood keeps refusing is attempted on every fill sweep, with no
 *   bound;
 * - software Max Loss skips a position with a stored stop id even when that
 *   stop is dead;
 * - every stop id stored before the switch went off is cleared or confirmed
 *   live: with the switch on they are trusted again.
 *
 * Not an environment variable on purpose: Railway variables come from a config
 * file, and a new one would drift from it. Tests flip `enabled`.
 */
export const brokerStops = { enabled: false };
