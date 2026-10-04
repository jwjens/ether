"use strict";
// audiod/cart-observe.js — is a fired cart/jingle actually reaching anyone? (pure; engine.js _cartObserve calls it)
//
// The jingle overlay confirms FIRING from the levels frame: deck signal, or failing that a loaded-and-active deck.
// On 10/03 at OV that confirmation said FIRING for hours while the aux output — the ONLY way an aux-routed slot
// (SlotKind::Source: D/E/F, S1–S5) reaches the room — was dead. Deck peak is measured BEFORE the output device, so
// real signal on a dead aux is still silence on the PA.
//
// THE RULE NOW (2026-10-04): if an aux device is chosen and is not open, a cart whose every channel is aux-routed is a
// FAULT — never FIRING, whatever the deck peak says. One main-path channel (e.g. CART) among them keeps it audible.
// No aux device chosen is the operator's routing (no device = silence, by ruling), not an outage: unchanged. A levels
// frame without the aux fields (an older addon) is treated exactly as before.

function classifyCartFlow(lv, channels) {
  const chans = (channels && channels.length) ? channels : ["CART"];
  const find = (ch) => ((lv && lv.decks) || []).find(d => d && (d.id === ch || (ch === "CART" && d.id === 6)));
  let peak = 0;
  for (const ch of chans) { const d = find(ch); if (d && (d.peak || 0) > peak) peak = d.peak || 0; }
  // level_cart is bus.peaks[6] under a named field, so it speaks only for the fallback slot.
  if (chans.includes("CART")) { const legacy = (lv && (lv.cart || lv.level_cart)) || 0; if (legacy > peak) peak = legacy; }

  const auxDown = !!(lv && lv.aux_open === false && lv.aux_device);
  if (auxDown && chans.every(ch => { const d = find(ch); return !!(d && d.aux_routed); })) {
    return { flowing: false, peak, fault: true,
             how: `aux output down — "${lv.aux_device}" is ${lv.aux_state || "not open"}; ${chans.join("+")} cannot reach the room` };
  }
  if (peak > 0.0001) return { flowing: true, peak, how: "signal" };
  const loaded = chans.some(ch => { const d = find(ch); return !!(d && d.source_present && d.active && !d.paused); });
  return { flowing: loaded, peak, how: loaded ? "loaded-and-active (NOT signal)" : "nothing" };
}

module.exports = { classifyCartFlow };
