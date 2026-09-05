// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATOR CAPABILITY TOKENS — provenance the asserting party cannot forge
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM THIS REPLACES (measured 2026-09-04, docs/iris-transport-provenance-2026-09-04.md §1.2):
//
//     $ curl -X POST http://127.0.0.1:3400/ -d '{"action":"stop","source":"operator"}'
//     {"ok":true}
//
// `cmd.source` was a field on a JSON body. Whoever sent the body set it. There was no issuer and no
// verification, so the "operator-commanded" gate could be satisfied by anything that could reach the
// port — Iris included, and she is exactly the party the gate exists to constrain.
//
// THE RULE: provenance cannot be asserted by the party whose initiative is in question.
//
// So Ether mints instead. The operator's words already arrive HERE first — the Iris panel sends them
// to main, which relays them to Iris over SSE (main.js, `iris:chat-send`; Iris is a pure client with
// no inbound port). Ether reads the raw text, extracts a verb DETERMINISTICALLY (no model — see
// iris-transport-phrases.js), and mints a token that is:
//
//   • VERB-SCOPED   — a token minted from "skip" can only ever skip. A relay cannot widen it to stop.
//   • SINGLE-USE    — burned on the first successful verification.
//   • SHORT-LIVED   — TTL below. A transport command firing ten minutes late is its own accident.
//   • UNFORGEABLE   — 256 bits of CSPRNG, and Ether honours only tokens it has itself issued.
//
// Iris cannot mint one. Neither can curl, nor anything else on the LAN. No operator utterance means
// no token, which means no transport — regardless of what the model concludes, what a tool is named,
// or what any system prompt says.
//
// WHAT THIS IS NOT: it does not defend against a compromised Iris process replaying inside the TTL
// for the verb the operator just authorised. That is the same trust boundary as the operator's own
// keyboard, and it is accepted deliberately.

const crypto = require('crypto');
const phrases = require('./iris-transport-phrases');

// 90 seconds. Long enough for Iris to receive the utterance, think, and call a tool; short enough
// that a token cannot outlive the operator's attention on what they just asked for.
const TTL_MS = 90 * 1000;

// A cap so a chatty session cannot grow the map without bound. Oldest go first.
const MAX_OUTSTANDING = 64;

/** token -> { verb, phrase, utteranceId, text, issuedAt, expiresAt, used } */
const tokens = new Map();

function sweep(now = Date.now()) {
  for (const [t, rec] of tokens) if (rec.used || rec.expiresAt <= now) tokens.delete(t);
  while (tokens.size > MAX_OUTSTANDING) tokens.delete(tokens.keys().next().value);
}

/**
 * Consider an operator utterance and mint a token if it authorises a transport verb.
 * Called from the chat channel BEFORE the text is relayed to Iris.
 *
 * @returns {{token: string, verb: string, phrase: string, expiresAt: number} | null}
 */
function mintFromUtterance(text, utteranceId = null) {
  const now = Date.now();
  sweep(now);

  const hit = phrases.resolve(text);
  if (!hit) return null;                       // nothing authorised — the overwhelmingly common case

  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, {
    verb: hit.verb,
    phrase: hit.phrase,
    utteranceId,
    text: String(text || '').slice(0, 200),    // kept for the ledger/audit line, not for matching
    issuedAt: now,
    expiresAt: now + TTL_MS,
    used: false,
  });
  return { token, verb: hit.verb, phrase: hit.phrase, expiresAt: now + TTL_MS };
}

/**
 * Verify a token against the action being requested, and BURN it on success.
 *
 * Every failure is distinguishable, because "refused" with no reason is how a gate becomes
 * impossible to debug and then gets switched off.
 *
 * @returns {{ok: true, verb: string, phrase: string, text: string} |
 *           {ok: false, reason: string}}
 */
function consume(token, action) {
  const now = Date.now();
  if (!token || typeof token !== 'string') return { ok: false, reason: 'no_operator_token' };

  const rec = tokens.get(token);
  if (!rec)                    return { ok: false, reason: 'unknown_or_spent_token' };
  if (rec.used)                { tokens.delete(token); return { ok: false, reason: 'token_already_used' }; }
  if (rec.expiresAt <= now)    { tokens.delete(token); return { ok: false, reason: 'token_expired' }; }

  // THE SECOND DERIVATION. Ether extracted `rec.verb` from the raw text; the caller independently
  // asks for `action`. Both must name the same verb, and one of the two was not produced by a model.
  // A relay that drifts — "skip" heard, `stop` requested — is refused, not reconciled.
  if (rec.verb !== action)     return { ok: false, reason: 'token_verb_mismatch', expected: rec.verb };

  rec.used = true;
  tokens.delete(token);
  return { ok: true, verb: rec.verb, phrase: rec.phrase, text: rec.text };
}

/** Outstanding, unexpired tokens — for the health surface, never for authorisation. */
function outstanding() {
  const now = Date.now();
  sweep(now);
  return [...tokens.values()].map((r) => ({
    verb: r.verb, phrase: r.phrase, utteranceId: r.utteranceId,
    secondsLeft: Math.max(0, Math.round((r.expiresAt - now) / 1000)),
  }));
}

/** Test seam only. Never called by the app. */
function _reset() { tokens.clear(); }

module.exports = { mintFromUtterance, consume, outstanding, knownVerbs: phrases.knownVerbs, TTL_MS, _reset };
