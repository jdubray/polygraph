// Timer-duration resolution (FR-4.1): fireIn (ISO-8601 duration string) |
// fireInMs (number) | fireAt (ms epoch). Anything else is a hard error —
// never a silent fire-immediately.
'use strict';

const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Parse an ISO-8601 duration to milliseconds. Years/months use the civil
 *  approximations (365d/30d) — durable timers at that horizon don't need
 *  calendar arithmetic, they need monotonic ordering. */
export function parseIsoDurationMs(text) {
  const m = ISO_DURATION.exec(text);
  if (!m || text === 'P' || text === 'PT') return null;
  const [, y, mo, w, d, h, min, s] = m.map((v) => (v === undefined ? 0 : Number(v)));
  if ([y, mo, w, d, h, min, s].every((v) => v === 0) && !/\d/.test(text)) return null;
  return (((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60 + min) * 60_000 + s * 1000;
}

/** Resolve a timer intent's fire time to an absolute ms epoch, or throw. */
export function resolveFireAt(intent, now) {
  if (typeof intent.fireAt === 'number' && Number.isFinite(intent.fireAt)) return intent.fireAt;
  if (typeof intent.fireInMs === 'number' && Number.isFinite(intent.fireInMs) && intent.fireInMs >= 0) {
    return now + intent.fireInMs;
  }
  if (typeof intent.fireIn === 'string') {
    const ms = parseIsoDurationMs(intent.fireIn);
    if (ms !== null) return now + ms;
    throw new Error(`timer '${intent.key}': unparseable ISO-8601 duration '${intent.fireIn}'`);
  }
  throw new Error(`timer '${intent.key}': needs one of fireIn (ISO-8601 string), fireInMs (number), fireAt (ms epoch)`);
}
