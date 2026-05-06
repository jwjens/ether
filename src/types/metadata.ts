// src/types/metadata.ts — shared library-column and metadata type definitions

export const ALL_LIB_COLS = ["title","artist","album","year","genre","bpm","format","duration","category","plays"] as const;
export type LibCol = typeof ALL_LIB_COLS[number];
export const LIB_COL_LABELS: Record<LibCol, string> = {
  title: "Title", artist: "Artist", album: "Album", year: "Year",
  genre: "Genre", bpm: "BPM", format: "Format", duration: "Duration",
  category: "Category", plays: "Plays",
};

export const LIB_COL_DEFAULT_WIDTHS: Record<LibCol, number> = {
  title: 150, artist: 120, album: 110, year: 50, genre: 80,
  bpm: 50, format: 60, duration: 70, category: 80, plays: 50,
};

export interface MetadataDefinition {
  id: number;
  uuid: string;
  station_id: number;
  name: string;
  data_type: "text" | "number" | "single_choice" | "multi_choice" | "boolean" | "date";
  description: string | null;
  is_built_in: number;
  is_required: number;
  display_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MetadataVocabulary {
  id: number;
  uuid: string;
  station_id: number;
  definition_id: number;
  value: string;
  display_order: number;
  color: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type StandardColumn = {
  kind: 'standard';
  id: LibCol;
  label: string;
};

export type MetadataColumn = {
  kind: 'metadata';
  defId: number;
  defUuid: string;
  label: string;
  dataType: MetadataDefinition['data_type'];
  width: number;
};

export type LibraryColumn = StandardColumn | MetadataColumn;
