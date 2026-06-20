import { useEffect, useState } from "react";

// True when this install's music library is BORROWED from another account via a cross-license
// grant. When borrowed, the install-scoped catalog (songs/artists/albums) is READ-ONLY on this
// install — ingest, core-field edits, and deletes are disabled. Station-scoped programming and
// tagging of those songs (categories, clocks, song_metadata_values, station_programming) stay
// fully editable: that's this install's OWN data, the whole point of "one library, many stations".
//
// Flag lives in install_config_kv.library_borrowed (set manually for the trial; later learned
// from a grant hint on /account/connect). This is the UX layer only — the hard guarantee is the
// writer guard in electron/sync/mutation-writer.js, which rejects local catalog writes even if a
// UI control is missed.
export function useLibraryBorrowed(): boolean {
  const [borrowed, setBorrowed] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const r = await (window as any).ether?.installConfigKv?.get?.("library_borrowed");
        const v = r?.row?.value;
        if (alive) setBorrowed(!!v && v !== "0" && v !== "");
      } catch {
        if (alive) setBorrowed(false);
      }
    };
    read();
    // Re-read on an explicit change signal (e.g. a future grant-hint sync sets the flag).
    const onChange = () => read();
    window.addEventListener("ether:install-config-changed", onChange);
    return () => { alive = false; window.removeEventListener("ether:install-config-changed", onChange); };
  }, []);

  return borrowed;
}
