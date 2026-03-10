import { useState, useEffect } from "react";

interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: string;
}

interface Props {
  onOutputChange: (deviceId: string) => void;
  onInputChange: (deviceId: string) => void;
  currentOutput: string;
  currentInput: string;
}

export default function AudioDevices({ onOutputChange, onInputChange, currentOutput, currentInput }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDevices = async () => {
    try {
      // Request permission first so labels show up
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === "audioinput" || d.kind === "audiooutput").map(d => ({
        deviceId: d.deviceId,
        label: d.label || ("Device " + d.deviceId.substring(0, 8)),
        kind: d.kind,
      })));
    } catch (e) {
      setError("Could not access audio devices: " + e);
    }
    setLoading(false);
  };

  useEffect(() => { loadDevices(); }, []);

  // Listen for device changes (plug/unplug)
  useEffect(() => {
    const handler = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, []);

  const inputs = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");

  if (loading) return <div className="text-xs text-zinc-500">Scanning audio devices...</div>;
  if (error) return <div className="text-xs text-red-400">{error}</div>;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold text-zinc-300">Audio Devices</h2>
      <div className="text-xs text-zinc-500">Select your audio interface. Changes take effect on the next song. Plug/unplug detection is automatic.</div>

      <div className="grid grid-cols-2 gap-4">
        {/* Output */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 space-y-2">
          <div className="text-xs font-bold text-zinc-300 uppercase">Output Device (Speakers / Board)</div>
          <div className="text-[10px] text-zinc-500">Where music plays. Select your Wheatstone, Focusrite, or studio monitors.</div>
          <div className="space-y-1">
            {outputs.length === 0 ? (
              <div className="text-xs text-zinc-600 italic">No output devices found</div>
            ) : outputs.map(d => (
              <button key={d.deviceId} onClick={() => onOutputChange(d.deviceId)}
                className={currentOutput === d.deviceId
                  ? "w-full px-3 py-2 text-left bg-blue-900 border border-blue-600 rounded text-xs text-white font-medium"
                  : "w-full px-3 py-2 text-left bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 hover:bg-zinc-700"
                }>
                <div className="flex items-center justify-between">
                  <span>{d.label}</span>
                  {currentOutput === d.deviceId && <span className="text-[9px] text-blue-400 font-bold">ACTIVE</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 space-y-2">
          <div className="text-xs font-bold text-zinc-300 uppercase">Input Device (Microphone)</div>
          <div className="text-[10px] text-zinc-500">For voice tracking and live mic. Select your Focusrite, USB mic, or board return.</div>
          <div className="space-y-1">
            {inputs.length === 0 ? (
              <div className="text-xs text-zinc-600 italic">No input devices found</div>
            ) : inputs.map(d => (
              <button key={d.deviceId} onClick={() => onInputChange(d.deviceId)}
                className={currentInput === d.deviceId
                  ? "w-full px-3 py-2 text-left bg-emerald-900 border border-emerald-600 rounded text-xs text-white font-medium"
                  : "w-full px-3 py-2 text-left bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 hover:bg-zinc-700"
                }>
                <div className="flex items-center justify-between">
                  <span>{d.label}</span>
                  {currentInput === d.deviceId && <span className="text-[9px] text-emerald-400 font-bold">ACTIVE</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <button onClick={loadDevices} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-400">Rescan Devices</button>
    </div>
  );
}