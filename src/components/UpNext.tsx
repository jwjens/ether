import { useState, useRef } from "react";
import { engine } from "../audio/engine";

interface Props {
  queueLen: number;
  onQueueChange: () => void;
}

export default function UpNext({ queueLen, onQueueChange }: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState(false);

  const queue = engine.getQueue();

  const rebuild = (newQ: { filePath: string; title: string; artist: string }[]) => {
    engine.clearQueue();
    engine.addToQueue(newQ);
    onQueueChange();
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    setDragOverIdx(null);
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        const q = engine.getQueue();
        q.splice(targetIdx, 0, { filePath: cart.filePath, title: cart.title, artist: cart.artist || "" });
        rebuild(q);
        return;
      } catch {}
    }
    const sourceIdx = dragIdx;
    if (sourceIdx === null || sourceIdx === targetIdx) return;
    const q = engine.getQueue();
    const item = q.splice(sourceIdx, 1)[0];
    q.splice(targetIdx, 0, item);
    rebuild(q);
    setDragIdx(null);
  };

  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };

  const handleListDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/cart")) { e.preventDefault(); setDropTarget(true); }
  };

  const handleListDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(false);
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        engine.addToQueue([{ filePath: cart.filePath, title: cart.title, artist: cart.artist || "" }]);
        onQueueChange();
      } catch {}
    }
  };

  const handleContext = (e: React.MouseEvent, idx: number) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, idx }); };
  const closeContext = () => setContextMenu(null);

  const moveUp = (idx: number) => { if (idx <= 0) return; const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.splice(idx - 1, 0, item); rebuild(q); closeContext(); };
  const moveDown = (idx: number) => { const q = engine.getQueue(); if (idx >= q.length - 1) return; const item = q.splice(idx, 1)[0]; q.splice(idx + 1, 0, item); rebuild(q); closeContext(); };
  const moveToTop = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.unshift(item); rebuild(q); closeContext(); };
  const moveToBottom = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.push(item); rebuild(q); closeContext(); };
  const removeItem = (idx: number) => { const q = engine.getQueue(); q.splice(idx, 1); rebuild(q); closeContext(); };
  const playNext = (idx: number) => { moveToTop(idx); };

  const getCls = (i: number) => {
    let c = "flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 cursor-grab active:cursor-grabbing select-none ";
    if (dragIdx === i) c += "opacity-30 ";
    if (dragOverIdx === i) c += "border-t-2 border-t-blue-500 ";
    if (i === 0) c += "bg-zinc-800 ";
    else c += "hover:bg-zinc-800 ";
    return c;
  };

  return (
    <div style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }} onClick={closeContext}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.04em" }}>Up Next ({queueLen})</span>
        {queue.length > 0 && <button onClick={() => { engine.clearQueue(); onQueueChange(); }} className="text-[10px] text-zinc-600 hover:text-zinc-400">Clear All</button>}
      </div>
      <div className={"flex-1 overflow-y-auto " + (dropTarget ? "ring-2 ring-blue-500 ring-inset" : "")}
        onDragOver={handleListDragOver}
        onDragLeave={() => setDropTarget(false)}
        onDrop={handleListDrop}>
        {queue.length === 0 ? (
          <div className="px-3 py-8 text-[11px] text-zinc-600 italic text-center">
            <div className="mb-2">Queue empty</div>
            <div className="text-[9px]">Drag carts here or use GEN LOG</div>
          </div>
        ) : queue.slice(0, 50).map((item, i) => (
          <div key={i}
            draggable
            onDragStart={e => handleDragStart(e, i)}
            onDragOver={e => handleDragOver(e, i)}
            onDrop={e => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            onContextMenu={e => handleContext(e, i)}
            className={getCls(i)}>
            <span className="text-[9px] text-zinc-600 w-4 shrink-0 text-right">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-zinc-200 truncate">{item.title}</div>
              <div className="text-[9px] text-zinc-500 truncate">{item.artist}</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); removeItem(i); }} className="text-[9px] text-zinc-700 hover:text-red-400 px-1">x</button>
          </div>
        ))}
        {queue.length > 50 && <div className="px-3 py-2 text-[10px] text-zinc-600 text-center">+ {queue.length - 50} more</div>}
      </div>

      {contextMenu && (
        <div className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}>
          <div className="px-3 py-1 text-[10px] text-zinc-500 truncate border-b border-zinc-700">{queue[contextMenu.idx]?.title}</div>
          <button onClick={() => playNext(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Play Next</button>
          <button onClick={() => moveUp(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move Up</button>
          <button onClick={() => moveDown(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move Down</button>
          <button onClick={() => moveToTop(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move to Top</button>
          <button onClick={() => moveToBottom(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move to Bottom</button>
          <div className="border-t border-zinc-700"></div>
          <button onClick={() => removeItem(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-zinc-700">Remove</button>
        </div>
      )}
    </div>
  );
}
