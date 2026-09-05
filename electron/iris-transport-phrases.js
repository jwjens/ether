// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE REVIEWED TRANSPORT PHRASE LIST
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// This file is meant to be READ AND EDITED BY A HUMAN. It is the list of things an operator can say
// that will cause Ether to mint a transport capability token. If a phrase is not in this list, no
// token is minted, and Iris cannot move the air chain no matter what she concludes.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
//
// Provenance cannot be asserted by the party whose initiative is in question. If Iris sets
// `source:"operator"`, that field means "Iris says the operator asked" — which is exactly the claim
// the gate exists to doubt. So the determination is made HERE instead: in Ether, by deterministic
// string matching, on the operator's raw text, BEFORE Iris ever sees it. There is no model in this
// file. That is the entire point.
//
// ── HOW IT FAILS ───────────────────────────────────────────────────────────────────────────────
//
// It fails CLOSED. A phrasing that is not covered mints nothing, the gate holds, and the operator
// repeats themselves or uses the board — which is one second of friction. The opposite failure
// (minting a token nobody asked for) puts dead air on a live station. So when in doubt, LEAVE IT
// OUT. This list should grow from real operator language that was observed to fail, not from
// imagined phrasings.
//
// ── THE SAFETY NET THAT LETS THIS LIST BE IMPERFECT ────────────────────────────────────────────
//
// A token proves AN OPERATOR SPOKE A VERB. It does not prove they meant it as a command. "Stop
// talking" mints a `stop` token — that is a real false positive and it is tolerable, because a
// token alone does nothing. TWO INDEPENDENT DERIVATIONS MUST AGREE: Ether extracted the verb from
// the raw text, and Iris independently decided to call the transport tool with that same verb. One
// of the two is not a model. If Iris (correctly) does not treat "stop talking" as transport, the
// token simply expires unused. Both must point the same way before a fader moves.
//
// ── EDITING THIS FILE ──────────────────────────────────────────────────────────────────────────
//
// Every phrase below is covered by a test in `scripts/test-iris-transport-phrases.js`, and every
// phrase has a NEGATED variant tested too. Add a phrase → add its test. Run: `npm run test:iris-phrases`.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Phrases are token SEQUENCES, matched in order against the normalised utterance. Multi-word
// phrases are matched as a unit, so "next track" is one thing and a bare "next" is another.
const TRANSPORT_PHRASES = [
  {
    verb: 'skip',
    phrases: [
      'skip',
      'skip it',
      'skip this',
      'skip this one',
      'skip this track',
      'skip this song',
      'skip the song',
      'next track',
      'next song',
      'kill this song',        // real operator language; blunt and unambiguous
      'get out of this song',
      'dump this song',
    ],
  },
  {
    verb: 'next',
    phrases: [
      'next',
      'go next',
      'move on',
      'move to the next',
    ],
  },
  {
    verb: 'stop',
    phrases: [
      'stop',
      'stop it',
      'stop playback',
      'stop the deck',
      'stop the music',
      'stop playing',
      'halt playback',
    ],
  },
  {
    verb: 'pause',
    phrases: [
      'pause',
      'pause it',
      'pause playback',
      'pause the deck',
      'hold playback',
    ],
  },
  {
    verb: 'play',
    phrases: [
      'play',
      'play it',
      'start playback',
      'start the deck',
      'roll it',
      'fire it',
      'take it',               // console idiom: "take it" = put it to air
    ],
  },
  {
    verb: 'auto-on',
    phrases: [
      'auto on',
      'automation on',
      'turn on automation',
      'turn automation on',
      'go automatic',
      'go auto',
      'run automation',
    ],
  },
  {
    verb: 'auto-off',
    phrases: [
      'auto off',
      'automation off',
      'turn off automation',
      'turn automation off',
      'go manual',
      'manual mode',
      'stop automation',       // deliberately BEFORE 'stop' would match — see resolve() below
    ],
  },
];

// ── NEGATORS ───────────────────────────────────────────────────────────────────────────────────
//
// A negator anywhere in the NEGATION_WINDOW tokens BEFORE a matched phrase vetoes that match.
// "Don't skip this" must never mint a skip token. This is the explicit handling — not an
// afterthought, and every one of these has a test.
// NOTE: `stop` is deliberately NOT here, though an early draft had it. It is a VERB. As a negator it
// made "stop and skip" veto the skip and quietly mint a `stop` token — resolving an ambiguous
// compound instruction by picking one, which is precisely what rule 4 exists to prevent. `do` is out
// for the same class of reason: `not` already catches "do not", and `do` alone vetoed "do it".
const NEGATORS = new Set([
  'dont', 'not', 'never', 'no', 'cant', 'cannot', 'wont',
  'avoid', 'without', 'rather', 'instead', 'unless',
]);

// A NEGATOR ANYWHERE BEFORE A MATCH VETOES IT. There is deliberately no proximity window.
//
// An earlier draft looked back only 4 tokens, which is more precise and is WRONG. The test
// "id rather you didnt move to the next" proved it: `rather` correctly vetoed the long phrase
// `move to the next` at token 4, but the bare `next` phrase matched again at token 7 — six tokens
// past the negator, outside the window — and minted a token from an utterance that plainly declined
// to authorise anything. A long phrase pushes its own trailing short phrase out of the window.
//
// The blunt rule cannot leak that way. Its cost is false vetoes across sentence boundaries
// ("we're not doing spots this hour. skip this song." mints nothing), which fails CLOSED: the
// operator repeats themselves, and one second of friction is the correct price for never inventing
// authority the operator did not give.

// ── DELIBERATIVE OPENERS ───────────────────────────────────────────────────────────────────────
//
// An utterance that OPENS with one of these is a question about transport, not an instruction to
// perform it. "Should we skip this?" is the operator thinking out loud, and thinking out loud must
// not move a fader. Matched only at the START of the utterance, so "skip this, should I?" still
// mints (it is an instruction with a tag question).
const DELIBERATIVE_OPENERS = [
  'should', 'shall', 'would', 'could', 'do you think', 'what if', 'why did', 'why does',
  'when do', 'when should', 'is it', 'was that', 'did you', 'did we', 'can we ever',
  'what happens if', 'how do i', 'how do you', 'what does',
];

/**
 * Normalise an utterance to a token array.
 * Apostrophes are DELETED rather than split, so "don't" becomes the single token "dont" and matches
 * the negator list. Everything else non-alphanumeric becomes a separator.
 */
function tokenize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Index of the first occurrence of `needle` (token array) in `hay`, or -1. */
function indexOfSequence(hay, needle) {
  if (!needle.length || needle.length > hay.length) return -1;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** True if any negator appears before position `at`. See the NEGATORS comment for why there is no window. */
function negatedAt(tokens, at) {
  for (let i = 0; i < at; i++) {
    if (NEGATORS.has(tokens[i])) return true;
  }
  return false;
}

/** True if the utterance opens deliberatively (a question about transport, not a command). */
function isDeliberative(tokens) {
  const head = tokens.join(' ');
  return DELIBERATIVE_OPENERS.some((op) => head === op || head.startsWith(op + ' '));
}

/**
 * THE DETERMINATION. Returns the single transport verb this utterance authorises, or null.
 *
 * Rules, in order:
 *   1. A deliberative opener authorises nothing.
 *   2. Every phrase is matched; a phrase preceded by a negator is vetoed.
 *   3. LONGER PHRASES WIN AT THE SAME POSITION. "stop automation" is auto-off, not stop — without
 *      this, asking to leave automation would stop the audio, which is a dead-air bug.
 *   4. If more than one DISTINCT verb survives, authorise NOTHING. "Stop and then skip" is
 *      ambiguous, and ambiguity about the air chain resolves to silence, not to a guess.
 *
 * @returns {{verb: string, phrase: string} | null}
 */
function resolve(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  if (isDeliberative(tokens)) return null;

  const hits = [];
  for (const entry of TRANSPORT_PHRASES) {
    for (const phrase of entry.phrases) {
      const needle = tokenize(phrase);
      const at = indexOfSequence(tokens, needle);
      if (at < 0) continue;
      if (negatedAt(tokens, at)) continue;
      hits.push({ verb: entry.verb, phrase, at, len: needle.length });
    }
  }
  if (!hits.length) return null;

  // Rule 3: at any given position the most specific (longest) phrase is the real one.
  hits.sort((a, b) => (a.at - b.at) || (b.len - a.len));
  const best = hits[0];
  const covered = new Set();
  for (const h of hits) {
    // A hit that STARTS INSIDE the winning phrase is part of it, not a competing instruction
    // ("stop automation" contains "stop"; "skip this song" contains "skip").
    if (h.at >= best.at && h.at < best.at + best.len) continue;
    covered.add(h.verb);
  }
  covered.add(best.verb);

  // Rule 4: ambiguity fails closed.
  if (covered.size > 1) return null;
  return { verb: best.verb, phrase: best.phrase };
}

/** Every verb this list can authorise — used by the token store to validate what it is asked for. */
function knownVerbs() {
  return TRANSPORT_PHRASES.map((e) => e.verb);
}

module.exports = { resolve, tokenize, knownVerbs, TRANSPORT_PHRASES, NEGATORS, DELIBERATIVE_OPENERS };
