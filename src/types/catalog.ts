export type TagResidueReason = 'unmapped_code' | 'no_code_list' | 'broad_group_match' | 'model_mapped';

export interface TagResidue {
  fieldCode: string;
  textKey: string;
  rawText: string;
  reason: TagResidueReason;
  subjects: string[];
  suggestedDmz: string[];
  evidencePage: number;
  evidenceQuote: string;
}

export type ObservationDisposition =
  | { kind: 'standard'; authority: string; dmz: string; dmsm: string }
  | { kind: 'alias'; authority: string; dmz: string; dmsm: string }
  | { kind: 'group'; authority: string; groupName: string; members: string[] }
  | { kind: 'extension'; extCode: string; label: string }
  | { kind: 'linked'; authority: string; dmz: string; dmsm: string }
  | { kind: 'open' };

export type ReviewStatus = 'confirmed' | 'rejected' | 'pending';

export interface ObservationSample {
  accidentKey: string;
  rawText: string;
  quote: string;
}

export interface ObservationRow {
  fieldCode: string;
  fieldName: string;
  textKey: string;
  rawText: string;
  reason: TagResidueReason;
  accidentCount: number;
  status: ReviewStatus;
  weight: number | null;
  disposition: ObservationDisposition;
  authority: string | null;
  samples: ObservationSample[];
}

export interface ObservationStats {
  pending: number;
  confirmed: number;
  rejected: number;
  termAccuracy: number;
  weightedAccuracy: number;
}

export interface ObservationReport {
  total: number;
  rows: ObservationRow[];
  stats: ObservationStats;
}

export type PromoteTarget =
  | { kind: 'alias'; dmz: string }
  | { kind: 'link_standard'; dmz: string }
  | { kind: 'new_extension'; label: string }
  | { kind: 'existing_extension'; extCode: string };

export interface ObservationTask {
  id: string;
  accidentKey: string;
  tagResidue: TagResidue[];
}

export interface CatalogOption {
  value: string;
  code: string;
  aliases: string[];
  extension?: boolean;
}

export type CatalogOptions = Record<string, CatalogOption[]>;
