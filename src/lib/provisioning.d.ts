// Types for provisioning.js (pure sign-in provisioning decisions, Phase 3).
export interface AttachmentRow { station_uuid: string; role?: string }
export interface CloudStation { uuid: string; name?: string; call_letters?: string; frequency?: string }
export interface LocalStation { id?: number; uuid: string; name?: string }

export function selectAttachedStationsToMaterialize(args: {
  cloud?: CloudStation[];
  attachments?: AttachmentRow[];
  haveUuids?: Set<string>;
  tombstoned?: Set<string>;
}): CloudStation[];

export function chooseActiveStation(args: {
  localStations?: LocalStation[];
  attachments?: AttachmentRow[];
  hasActive?: boolean;
}): LocalStation | null;
