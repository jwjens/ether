// What the first-run restore screen says when the music download ends (OnboardingFlow).
//
// The jensj work PC, 2026-10-23 (docs/halloveen-join-61-file-errors-2026-10-23.md): the screen read `result.done`, a field
// downloadCatalogue() never returns. Its count is `downloaded` (electron/audio-library-r2.js), so every restore, even a
// complete one, said "no music could be downloaded". The verdict now comes from the job's own fields.

export interface RestoreResult {
  downloaded?: number;          // files pulled this run
  alreadyLocal?: number;        // files the cloud lists that were already in the catalogue
  remoteFiles?: number;         // files the cloud lists
  errors?: number;              // files that would not come down
  prunedFromManifest?: number;  // cloud-list entries for files the cloud does not have, removed by this restore
  aborted?: boolean;
  stalled?: boolean;            // set by the screen's own two-minute watchdog, not by the job
  fatal?: string;
}

export type RestoreOutcome =
  | { ok: true; sub: string }
  | { ok: false; message: string };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function restoreOutcome(result: RestoreResult | null | undefined): RestoreOutcome {
  const r = result || {};
  if (r.stalled) {
    return { ok: false, message: `The music download stopped responding — nothing transferred for two minutes. Your station's setup is installed; press Retry to download the music again.` };
  }
  if (r.aborted) return { ok: false, message: 'Music download was cancelled before it finished.' };
  if (r.fatal) return { ok: false, message: `Your station database was restored, but the music download failed: ${r.fatal}` };

  const got = r.downloaded ?? 0;
  const here = got + (r.alreadyLocal ?? 0);
  const errs = r.errors ?? 0;
  if (here === 0) {
    return { ok: false, message: `Your station database was restored, but no music could be downloaded from the cloud${errs ? ` (${plural(errs, 'file error', 'file errors')})` : ''}. Check that your plan includes cloud sync and that the library was uploaded from the source machine.` };
  }

  const parts = [`${plural(got, 'file', 'files')} downloaded`];
  if (r.alreadyLocal) parts.push(`${r.alreadyLocal.toLocaleString()} already here`);
  if (errs) parts.push(`${plural(errs, 'file', 'files')} skipped`);
  if (r.prunedFromManifest) parts.push(`${plural(r.prunedFromManifest, 'old cloud-list entry', 'old cloud-list entries')} cleaned up`);
  return { ok: true, sub: parts.join(' · ') };
}
