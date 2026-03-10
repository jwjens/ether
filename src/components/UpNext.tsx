import { engine } from "../audio/engine";

interface Props {
  queueLen: number;
}

export default function UpNext({ queueLen }: Props) {
  const queue = engine.getQueue();

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
        <span className="text-[10px] font-bold text-zinc-400 uppercase">Up Next ({queueLen})</span>
        {queue.length > 0 && <button onClick={() => engine.clearQueue()} className="text-[10px] text-zinc-600 hover:text-zinc-400">Clear</button>}
      </div>
      <div className="flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-zinc-600 italic text-center">Queue empty</div>
        ) : queue.slice(0, 30).map((item, i) => (
          <div key={i} className={"flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 " + (i === 0 ? "bg-zinc-800" : "hover:bg-zinc-800")}>
            <span className="text-[10px] text-zinc-600 w-5 shrink-0 text-right">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-zinc-200 truncate">{item.title}</div>
              <div className="text-[10px] text-zinc-500 truncate">{item.artist}</div>
            </div>
          </div>
        ))}
        {queue.length > 30 && <div className="px-3 py-2 text-[10px] text-zinc-600 text-center">+ {queue.length - 30} more</div>}
      </div>
    </div>
  );
}