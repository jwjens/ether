const fs = require('fs');

console.log('\n  Ether — Fix Deck Alternation\n');

let eng = fs.readFileSync('src/audio/engine.ts', 'utf8');

// Replace the handleDeckEnd to load to the OTHER deck
eng = eng.replace(
  /private handleDeckEnd = \(deckId: DeckId\) => \{[\s\S]*?this\.listeners\.forEach\(l => l\(deckId, deck\.getState\(\)\)\);[\s\S]*?\}\);[\s\S]*?\}[\s\S]*?\};/,
  `private handleDeckEnd = (deckId: DeckId) => {
    if (!this.autoAdvance) return;
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      this.refillCallback().then(songs => {
        this.queue.push(...songs);
        this.handleDeckEnd(deckId);
      });
      return;
    }
    if (this.queue.length === 0) return;
    let idx = 0;
    if (this.shuffle) idx = Math.floor(Math.random() * this.queue.length);
    const next = this.queue.splice(idx, 1)[0];
    // Load to the SAME deck (it just finished) - simpler and avoids overlap
    const deck = this.getDeck(deckId);
    if (deck) {
      deck.load(next.filePath, next.title, next.artist).then(() => {
        deck.play();
        this.listeners.forEach(l => l(deckId, deck.getState()));
      });
    }
  };`
);

// Fix the outroCrossfade check to not double-fire
if (eng.includes('checkOutroCrossfade')) {
  eng = eng.replace(
    /checkOutroCrossfade\(\) \{[\s\S]*?\n  \}/,
    `checkOutroCrossfade() {
    if (!this.outroCrossfade || !this.autoAdvance || this.outroPending) return;
    const deckA = this.getDeck("A");
    const deckB = this.getDeck("B");
    if (!deckA || !deckB) return;

    // Only check the deck that is currently playing
    const activeDeck = deckA.status === "playing" ? deckA : deckB.status === "playing" ? deckB : null;
    if (!activeDeck) return;
    const otherId: DeckId = activeDeck.id === "A" ? "B" : "A";
    const other = this.getDeck(otherId);
    if (!other) return;

    // Don't crossfade if other deck is already playing
    if (other.status === "playing") return;

    const pos = activeDeck.positionSec;
    const dur = activeDeck.durationSec;
    if (dur <= 0) return;

    let outroAt = (activeDeck as any).outroStartSec;
    if (!outroAt || outroAt <= 0) outroAt = dur - this.crossfadeDuration - 1;

    if (pos >= outroAt && pos < dur - 0.5) {
      this.outroPending = true;
      const queue = this.getQueue();
      if (queue.length > 0) {
        let idx = 0;
        if (this.shuffle) idx = Math.floor(Math.random() * queue.length);
        const next = queue.splice(idx, 1)[0];
        this.clearQueue();
        this.addToQueue(queue);
        other.load(next.filePath, next.title, next.artist).then(() => {
          this.crossfade(activeDeck.id, otherId, this.crossfadeDuration * 1000);
          setTimeout(() => { this.outroPending = false; }, this.crossfadeDuration * 1000 + 500);
        });
      }
    }
  }`
  );
}

fs.writeFileSync('src/audio/engine.ts', eng, 'utf8');
console.log('  FIXED engine.ts:');
console.log('    - Auto-advance loads to same deck (no overlap)');
console.log('    - Auto-crossfade only fires on the active deck');
console.log('    - Checks other deck isnt already playing before crossfade');
console.log('    - No more double-play\n');
console.log('  App should hot-reload.\n');
