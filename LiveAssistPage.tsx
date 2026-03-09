// src/pages/LiveAssistPage.tsx
import { useEngineStore, useUIStore } from '../store';

function DeckDisplay({ label, deck }: { label: string; deck: any }) {
  const pct = deck.durationMs > 0 ? (deck.positionMs / deck.durationMs) * 100 : 0;
  const remaining = deck.durationMs - deck.positionMs;
  const remStr = (() => {
    const s = Math.floor(remaining / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  })();

  return (
    <div className={`deck ${deck.status}`} style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="deck-id">{label}</span>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-display)', letterSpacing: '0.1em',
          textTransform: 'uppercase', padding: '2px 8px',
          background: deck.status === 'playing' ? 'var(--green-dim)' : deck.status === 'idle' && deck.isCued ? 'var(--amber-glow)' : 'var(--bg-raised)',
          color: deck.status === 'playing' ? 'var(--green-air)' : deck.isCued ? 'var(--amber)' : 'var(--text-muted)',
          borderRadius: 'var(--r-sm)',
        }}>
          {deck.status === 'playing' ? 'ON AIR' : deck.isCued ? 'READY' : deck.status.toUpperCase()}
        </span>
      </div>

      <div>
        <div className="deck-title">{deck.title || '— No track loaded —'}</div>
        <div className="deck-artist">{deck.artist || '\u00a0'}</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span className={`timecode ${deck.status === 'playing' ? 'running' : ''}`}>
          {(() => {
            const ms = deck.positionMs;
            const s = Math.floor(ms / 1000);
            return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
          })()}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-muted)' }}>
          -{remStr}
        </span>
      </div>

      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        {deck.introMs > 0 && (
          <div className="cue-marker intro" style={{ left: `${(deck.introMs / deck.durationMs) * 100}%` }} />
        )}
        {deck.outroMs > 0 && (
          <div className="cue-marker outro" style={{ left: `${((deck.durationMs - deck.outroMs) / deck.durationMs) * 100}%` }} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="transport-btn cue" title="Cue">⏮</button>
        <button className="transport-btn play" title="Play">▶</button>
        <button className="transport-btn" title="Pause">⏸</button>
        <button className="transport-btn" title="Stop">⏹</button>
        <div style={{ flex: 1 }} />
        <button className="transport-btn" title="Load next from queue" style={{ fontSize: 13 }}>
          NEXT
        </button>
      </div>
    </div>
  );
}

export default function LiveAssistPage() {
  const deckA = useEngineStore(s => s.deckA);
  const deckB = useEngineStore(s => s.deckB);
  const queue = useEngineStore(s => s.queue);
  const automationMode = useUIStore(s => s.automationMode);

  return (
    <div className="page-panel">
      <div className="page-header">
        <span className="page-title">Live / On-Air</span>
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: '0.1em',
          color: 'var(--amber)', textTransform: 'uppercase',
        }}>
          Mode: {automationMode}
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 0, overflow: 'hidden' }}>
        {/* Left: Decks */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, padding: 12, overflow: 'hidden' }}>
          {/* Dual decks */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <DeckDisplay label="A" deck={deckA} />
            <DeckDisplay label="B" deck={deckB} />
          </div>

          {/* Cart wall placeholder */}
          <div style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-lg)',
            padding: 12,
            flex: 1,
          }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: '0.12em',
              color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10,
            }}>
              Cart Wall
            </div>
            <div className="cart-wall" style={{ gridTemplateColumns: 'repeat(8, 1fr)', gridTemplateRows: 'repeat(3, 1fr)' }}>
              {Array.from({ length: 24 }).map((_, i) => (
                <div key={i} className="cart-btn empty" />
              ))}
            </div>
          </div>
        </div>

        {/* Right: Queue */}
        <div style={{
          width: 280, borderLeft: '1px solid var(--border-subtle)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            fontFamily: 'var(--font-display)', fontSize: 11,
            letterSpacing: '0.12em', color: 'var(--text-muted)',
            textTransform: 'uppercase',
          }}>
            Next Up ({queue.length})
          </div>
          <div className="log-queue" style={{ flex: 1 }}>
            {queue.length === 0 ? (
              <div style={{ padding: '24px 12px', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
                No log loaded.<br />Generate a log in Log Builder.
              </div>
            ) : (
              queue.map((item, i) => (
                <div
                  key={item.entryId}
                  className={`queue-item ${item.status === 'playing' ? 'playing' : item.status === 'played' ? 'played' : i === 0 ? 'current' : ''}`}
                >
                  <span className="queue-position">{i + 1}</span>
                  <span className="queue-time">{item.scheduledTime?.slice(0, 5) ?? '—'}</span>
                  <div className="queue-info">
                    <div className="queue-title">{item.title}</div>
                    <div className="queue-artist">{item.artist}</div>
                  </div>
                  <span className="queue-duration">
                    {Math.floor(item.durationMs / 60000)}:{Math.floor((item.durationMs % 60000) / 1000).toString().padStart(2,'0')}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
