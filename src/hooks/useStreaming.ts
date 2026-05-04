import { useState, useCallback } from 'react';

export function useStreaming() {
  const [streamMsg, setStreamMsg] = useState('');

  const goLive = useCallback(async (stationId: number) => {
    setStreamMsg('');
    const res = await (window as any).ether.invoke('stream:go-live', { stationId });
    if (res?.ok) {
      setStreamMsg(`✓ Streaming → ${res.server}:8000${res.mount}`);
      return { ok: true as const, server: res.server as string, mount: res.mount as string };
    } else {
      setStreamMsg('✗ ' + (res?.error || 'Failed to start stream'));
      return { ok: false as const, error: res?.error as string | undefined };
    }
  }, []);

  const stopLive = useCallback(async (stationId: number) => {
    await (window as any).ether.invoke('stream:stop-live', { stationId });
    setStreamMsg('');
    return { ok: true as const };
  }, []);

  return { goLive, stopLive, streamMsg };
}
