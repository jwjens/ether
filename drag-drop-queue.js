const fs = require('fs');

console.log('\n  Ether — Drag & Drop Queue Management\n');

// ============================================================
// Rewrite UpNext with full queue management
// ============================================================

fs.writeFileSync('src/components/UpNext.tsx', [
'import { useState, useRef, useCallback } from "react";',
'import { engine } from "../audio/engine";',
'',
'interface QueueItem {',
'  filePath: string;',
'  title: string;',
'  artist: string;',
'}',
'',
'interface Props {',
'  queueLen: number;',
'  onQueueChange: () => void;',
'}',
'',
'export default function UpNext({ queueLen, onQueueChange }: Props) {',
'  const [dragIdx, setDragIdx] = useState<number | null>(null);',
'  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);',
'  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);',
'  const [dropTarget, setDropTarget] = useState(false);',
'  const listRef = useRef<HTMLDivElement>(null);',
'',
'  const queue = engine.getQueue();',
'',
'  // ---- Internal drag to reorder ----',
'  const handleDragStart = (e: React.DragEvent, idx: number) => {',
'    setDragIdx(idx);',
'    e.dataTransfer.effectAllowed = "move";',
'    e.dataTransfer.setData("text/plain", String(idx));',
'  };',
'',
'  const handleDragOver = (e: React.DragEvent, idx: number) => {',
'    e.preventDefault();',
'    e.dataTransfer.dropEffect = "move";',
'    setDragOverIdx(idx);',
'  };',
'',
'  const handleDrop = (e: React.DragEvent, targetIdx: number) => {',
'    e.preventDefault();',
'    setDragOverIdx(null);',
'',
'    // Check if this is a cart drop (external)',
'    const cartData = e.dataTransfer.getData("application/cart");',
'    if (cartData) {',
'      try {',
'        const cart = JSON.parse(cartData);',
'        const q = engine.getQueue();',
'        q.splice(targetIdx, 0, { filePath: cart.filePath, title: cart.title, artist: cart.artist || "" });',
'        engine.clearQueue();',
'        engine.addToQueue(q);',
'        onQueueChange();',
'        return;',
'      } catch {}',
'    }',
'',
'    // Internal reorder',
'    const sourceIdx = dragIdx;',
'    if (sourceIdx === null || sourceIdx === targetIdx) return;',
'    const q = engine.getQueue();',
'    const item = q.splice(sourceIdx, 1)[0];',
'    q.splice(targetIdx, 0, item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    setDragIdx(null);',
'    onQueueChange();',
'  };',
'',
'  const handleDragEnd = () => {',
'    setDragIdx(null);',
'    setDragOverIdx(null);',
'  };',
'',
'  // ---- Drop zone for external carts ----',
'  const handleListDragOver = (e: React.DragEvent) => {',
'    if (e.dataTransfer.types.includes("application/cart")) {',
'      e.preventDefault();',
'      setDropTarget(true);',
'    }',
'  };',
'',
'  const handleListDrop = (e: React.DragEvent) => {',
'    e.preventDefault();',
'    setDropTarget(false);',
'    const cartData = e.dataTransfer.getData("application/cart");',
'    if (cartData) {',
'      try {',
'        const cart = JSON.parse(cartData);',
'        engine.addToQueue([{ filePath: cart.filePath, title: cart.title, artist: cart.artist || "" }]);',
'        onQueueChange();',
'      } catch {}',
'    }',
'  };',
'',
'  // ---- Right-click context menu ----',
'  const handleContext = (e: React.MouseEvent, idx: number) => {',
'    e.preventDefault();',
'    setContextMenu({ x: e.clientX, y: e.clientY, idx });',
'  };',
'',
'  const closeContext = () => setContextMenu(null);',
'',
'  const moveUp = (idx: number) => {',
'    if (idx <= 0) return;',
'    const q = engine.getQueue();',
'    const item = q.splice(idx, 1)[0];',
'    q.splice(idx - 1, 0, item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  const moveDown = (idx: number) => {',
'    const q = engine.getQueue();',
'    if (idx >= q.length - 1) return;',
'    const item = q.splice(idx, 1)[0];',
'    q.splice(idx + 1, 0, item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  const moveToTop = (idx: number) => {',
'    const q = engine.getQueue();',
'    const item = q.splice(idx, 1)[0];',
'    q.unshift(item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  const moveToBottom = (idx: number) => {',
'    const q = engine.getQueue();',
'    const item = q.splice(idx, 1)[0];',
'    q.push(item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  const removeItem = (idx: number) => {',
'    const q = engine.getQueue();',
'    q.splice(idx, 1);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  const playNext = (idx: number) => {',
'    const q = engine.getQueue();',
'    const item = q.splice(idx, 1)[0];',
'    q.unshift(item);',
'    engine.clearQueue();',
'    engine.addToQueue(q);',
'    closeContext();',
'    onQueueChange();',
'  };',
'',
'  return (',
'    <div className="bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-full overflow-hidden" onClick={closeContext}>',
'      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">',
'        <span className="text-[10px] font-bold text-zinc-400 uppercase">Up Next ({queueLen})</span>',
'        {queue.length > 0 && <button onClick={() => { engine.clearQueue(); onQueueChange(); }} className="text-[10px] text-zinc-600 hover:text-zinc-400">Clear All</button>}',
'      </div>',
'      <div ref={listRef} className={"flex-1 overflow-y-auto " + (dropTarget ? "ring-2 ring-blue-500 ring-inset" : "")}',
'        onDragOver={handleListDragOver}',
'        onDragLeave={() => setDropTarget(false)}',
'        onDrop={handleListDrop}>',
'        {queue.length === 0 ? (',
'          <div className="px-3 py-8 text-[11px] text-zinc-600 italic text-center">',
'            <div className="mb-2">Queue empty</div>',
'            <div className="text-[9px]">Drag carts here or use GEN LOG</div>',
'          </div>',
'        ) : queue.slice(0, 50).map((item, i) => (',
'          <div key={i}',
'            draggable',
'            onDragStart={e => handleDragStart(e, i)}',
'            onDragOver={e => handleDragOver(e, i)}',
'            onDrop={e => handleDrop(e, i)}',
'            onDragEnd={handleDragEnd}',
'            onContextMenu={e => handleContext(e, i)}',
'            className={"flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 cursor-grab active:cursor-grabbing select-none "'
'              + (dragIdx === i ? "opacity-30 " : "")',
'              + (dragOverIdx === i ? "border-t-2 border-t-blue-500 " : "")',
'              + (i === 0 ? "bg-zinc-800 " : "hover:bg-zinc-800 ")}>',
'            <span className="text-[9px] text-zinc-600 w-4 shrink-0 text-right">{i + 1}</span>',
'            <div className="flex-1 min-w-0">',
'              <div className="text-[11px] text-zinc-200 truncate">{item.title}</div>',
'              <div className="text-[9px] text-zinc-500 truncate">{item.artist}</div>',
'            </div>',
'            <button onClick={(e) => { e.stopPropagation(); removeItem(i); }} className="text-[9px] text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 px-1">x</button>',
'          </div>',
'        ))}',
'        {queue.length > 50 && <div className="px-3 py-2 text-[10px] text-zinc-600 text-center">+ {queue.length - 50} more</div>}',
'      </div>',
'',
'      {/* Context menu */}',
'      {contextMenu && (',
'        <div className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px]"',
'          style={{ left: contextMenu.x, top: contextMenu.y }}',
'          onClick={e => e.stopPropagation()}>',
'          <div className="px-3 py-1 text-[10px] text-zinc-500 truncate border-b border-zinc-700">{queue[contextMenu.idx]?.title}</div>',
'          <button onClick={() => playNext(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Play Next</button>',
'          <button onClick={() => moveUp(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move Up</button>',
'          <button onClick={() => moveDown(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move Down</button>',
'          <button onClick={() => moveToTop(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move to Top</button>',
'          <button onClick={() => moveToBottom(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700">Move to Bottom</button>',
'          <div className="border-t border-zinc-700"></div>',
'          <button onClick={() => removeItem(contextMenu.idx)} className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-zinc-700">Remove</button>',
'        </div>',
'      )}',
'    </div>',
'  );',
'}',
].join('\n'), 'utf8');
console.log('  REWROTE src/components/UpNext.tsx (drag + drop + context menu)');

// ============================================================
// Update CartWall to support drag out to queue
// ============================================================

let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');
if (!cart.includes('application/cart')) {
  // Add drag data to cart buttons
  cart = cart.replace(
    "                onClick={() => fireCart(i)}",
    "                onClick={() => fireCart(i)}\n                draggable\n                onDragStart={(e) => { e.dataTransfer.setData('application/cart', JSON.stringify({ filePath: slot.file_path, title: slot.title || 'Cart ' + (i+1), artist: '' })); e.dataTransfer.effectAllowed = 'copy'; }}"
  );
  fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
  console.log('  UPDATED CartWall.tsx (drag carts to queue)');
}

// ============================================================
// Update App.tsx to pass onQueueChange to UpNext
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');
if (!app.includes('onQueueChange')) {
  app = app.replace(
    '<UpNext queueLen={queueLen} />',
    '<UpNext queueLen={queueLen} onQueueChange={() => setQueueLen(engine.getQueue().length)} />'
  );
  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (queue change callback)');
}

console.log('\n  Done! App should hot-reload or restart: npm run tauri:dev');
console.log('');
console.log('  UP NEXT QUEUE:');
console.log('    Drag to reorder — grab any song and move it');
console.log('    Right-click for menu:');
console.log('      Play Next — move to top of queue');
console.log('      Move Up / Move Down');
console.log('      Move to Top / Move to Bottom');
console.log('      Remove — take it out');
console.log('    X button on hover to quick-remove');
console.log('    Clear All button at top');
console.log('');
console.log('  CART WALL → QUEUE:');
console.log('    Drag any cart button into the Up Next list');
console.log('    Drop between songs to insert at that position');
console.log('    Drop at bottom to append');
console.log('    Blue highlight shows drop zone');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.0.2 drag-drop queue + cart-to-queue + context menu"');
console.log('    git push\n');
