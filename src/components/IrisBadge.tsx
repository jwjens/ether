import { useEffect, useRef, useState } from "react";
import "./IrisBadge.css";

// Iris presence surface (contract: docs/iris-ether-contract.md). Bottom-right badge, present from first
// launch; click → chat panel. Iris is a separate process — if she isn't running the badge shows "offline"
// cleanly and the panel explains how to reach her. The badge glows/pulses purple while she is speaking.
// Chat: prompt out via ether.iris.chatSend; reply/speaking/presence in via the onReply/onSpeaking/
// onConnected events. No transport is issued from here — this surface is chat + the scheduling command.
type Msg = { from: "you" | "iris"; text: string };
type Status = "offline" | "connecting" | "online-idle" | "thinking" | "speaking" | "error";

export default function IrisBadge() {
  const iris = (window as any).ether?.iris;
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    // The presence surface must NEVER crash the broadcast UI. If the loaded preload is missing any iris
    // method — e.g. a renderer/preload version skew during an auto-update — guard every call so the badge
    // just stays offline instead of throwing into the error boundary. Air-safety over presence.
    if (!iris || typeof iris.onConnected !== "function") return;
    const hC = iris.onConnected?.((c: boolean) => { setConnected(!!c); if (!c) { setSpeaking(false); setThinking(false); } });
    const hS = iris.onSpeaking?.((v: { speaking: boolean }) => setSpeaking(!!v?.speaking));
    const hR = iris.onReply?.((v: { id: number | null; text: string }) => {
      setThinking(false); setError(false);
      setMsgs(m => [...m, { from: "iris", text: v?.text || "" }]);
    });
    return () => { iris.offConnected?.(hC); iris.offSpeaking?.(hS); iris.offReply?.(hR); };
  }, [iris]);

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [msgs, thinking]);

  const status: Status = !iris ? "offline"
    : error ? "error"
    : !connected ? "offline"
    : speaking ? "speaking"
    : thinking ? "thinking"
    : "online-idle";
  const label: Record<Status, string> = {
    offline: "Iris — offline", connecting: "Iris — connecting…", "online-idle": "Iris",
    thinking: "Iris — thinking…", speaking: "Iris — speaking", error: "Iris — error",
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMsgs(m => [...m, { from: "you", text }]);
    setDraft("");
    if (!iris || !connected) {
      setMsgs(m => [...m, { from: "iris", text: "I'm not connected right now. In the installed app I start with Ether automatically; in dev, launch the Iris app and I'll be right here." }]);
      return;
    }
    setThinking(true);
    try { iris.chatSend?.({ id: ++reqId.current, text }); }
    catch { setThinking(false); setError(true); }
  };

  return (
    <div className="iris-root">
      {open && (
        <div className="iris-panel" role="dialog" aria-label="Iris">
          <div className="iris-head">
            <span className={`iris-dot ${status}`} />
            <span className="iris-title">{label[status]}</span>
            <button className="iris-x" onClick={() => setOpen(false)} aria-label="Close Iris">✕</button>
          </div>
          <div className="iris-msgs" ref={listRef}>
            {msgs.length === 0 && (
              <div className="iris-empty">
                {connected
                  ? "Ask me anything — or say “generate August for Magical Forest.”"
                  : "Iris isn’t running. In the installed app I start with Ether; in dev, launch the Iris app to chat."}
              </div>
            )}
            {msgs.map((m, i) => <div key={i} className={`iris-msg ${m.from}`}>{m.text}</div>)}
            {thinking && <div className="iris-msg iris iris-typing">…</div>}
          </div>
          <div className="iris-input">
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") send(); }}
              placeholder="Ask Iris…"
              aria-label="Message Iris"
            />
            <button onClick={send} disabled={!draft.trim()}>Send</button>
          </div>
        </div>
      )}
      <button
        className={`iris-badge ${status}${speaking ? " speaking" : ""}`}
        onClick={() => setOpen(o => !o)}
        aria-label={label[status]}
        title={label[status]}
      >
        <span className="iris-badge-glyph">◈</span>
        <span className={`iris-badge-dot ${status}`} />
      </button>
    </div>
  );
}
