export type EntityKind = 'ACC' | 'P' | 'V' | 'E' | 'R' | 'I' | 'O';

export type PresenceStatus =
  | 'present'
  | 'explicit_negative'
  | 'not_mentioned'
  | 'not_applicable'
  | 'unreadable'
  | 'source_conflict'
  | 'needs_review';

export type ReviewStatus =
  | 'draft'
  | 'checked'
  | 'disputed'
  | 'specialist_review';

export type UserRole = 'annotator' | 'reviewer' | 'adjudicator';

export type GroupCode = 'G01' | 'G02' | 'G03' | 'G04' | 'G05' | 'G06' | 'G07' | 'G08';

export interface FieldDefinition {
  fieldCode: string;
  groupCode: GroupCode;
  groupName: string;
  fieldName: string;
  applicableKinds: EntityKind[];
  valueType: string;
  existingCodeTable: string;
  statusNote: string;
  allowMultiple: boolean;
  presetOptions: string[];
  isSensitivePii?: boolean;
  isDerived?: boolean;
  isLegalOrRelation?: boolean;
}

export interface VocabularySupplementItem {
  fieldCode: string;
  fieldName: string;
  applicableSubject: string;
  singleMultiRule: string;
  supplementType: string;
  standardCode: string;
  standardName: string;
  candidateOptions: string[];
  definition: string;
  synonyms: string;
  exclusions: string;
  allowMultiple: boolean;
  approvalStatus: '待审核' | '已核定';
  reviewComment: string;
}

export interface EvidenceItem {
  id: string;
  page: number;
  quote: string;
}

export interface EntityItem {
  id: string;
  kind: EntityKind;
  label: string;
  subtitle?: string;
  roleLabel?: string;
}

export interface FieldRecord {
  recordId: string;
  entityId: string;
  fieldCode: string;
  presenceStatus: PresenceStatus;
  rawValue: string;
  normalizedValues: string[];
  evidences: EvidenceItem[];
  reviewStatus: ReviewStatus;
  disputeReason: string;
  adjudicatorNote: string;
  updatedByRole: UserRole;
  updatedAt: string;
}

export type LegalCategory = 'violation' | 'cause' | 'liability';

export type CausalLinkStatus =
  | 'unspecified'
  | 'explicit_linked'
  | 'explicit_unlinked'
  | 'multiple_mixed';

export interface LegalConclusionItem {
  id: string;
  category: LegalCategory;
  subjectId: string;
  eventId: string;
  presenceStatus: PresenceStatus;
  rawText: string;
  lawArticle: string;
  conclusionLabel: string;
  causalLinkStatus?: CausalLinkStatus;
  linkedViolationIds?: string[];
  linkedCauseIds?: string[];
  linkedEntityIds?: string[];
  linkedVocabTerms?: string[];
  linkConsistencyConfirmed?: boolean;
  linkConsistencyFingerprint?: string;
  evidences: EvidenceItem[];
  reviewStatus: ReviewStatus;
  disputeReason: string;
  adjudicatorNote: string;
}

export interface EventRelationItem {
  id: string;
  fieldCode?: string;
  eventId: string;
  stageOrder: number;
  sourceId: string;
  action: string;
  relationType?: string;
  targetId: string;
  collisionMode: string;
  directionNote: string;
  presenceStatus?: PresenceStatus;
  evidences: EvidenceItem[];
  reviewStatus: ReviewStatus;
  disputeReason: string;
  adjudicatorNote: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorRole: UserRole;
  actorName: string;
  action: string;
  targetRef: string;
  comment: string;
}

export interface CaseDocument {
  caseId: string;
  documentId?: string;
  title: string;
  pilotCode: string;
  scenarioSummary: string;
  pdfUrl: string;
  sourceFilename: string;
  fileSha256: string;
  sourceHashFull?: string;
  pageCount: number;
  manualVersion: string;
  annotationVersion: string;
  maskPiiOnExport: boolean;
  annotatorName: string;
  reviewerName: string;
  adjudicatorName: string;
  entities: EntityItem[];
  fieldRecords: FieldRecord[];
  legalConclusions: LegalConclusionItem[];
  relations: EventRelationItem[];
  checklist: Record<string, boolean>;
  auditLog: AuditLogEntry[];
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ReadinessSummary {
  totalFieldRecords: number;
  totalLegalItems: number;
  totalRelations: number;
  statusCounts: Record<ReviewStatus, number>;
  blockingPresenceCount: number;
  validationErrors: number;
  checklistCheckedCount: number;
  checklistTotalCount: number;
  eligibleForScoring: boolean;
  blockingReasons: string[];
}

export type WorkItemFilterStatus =
  | 'all'
  | 'pending_action'
  | 'draft'
  | 'disputed'
  | 'blocking_or_error'
  | 'checked'
  | 'specialist_review';

export type FieldFilterBucket = WorkItemFilterStatus | 'unstarted';

export interface CaseWorkItem {
  id: string;
  itemType: 'field' | 'legal' | 'relation';
  entityId: string;
  code: string;
  title: string;
  presenceStatus: PresenceStatus;
  reviewStatus: ReviewStatus;
  hasBlockingOrError: boolean;
  needsAttention: boolean;
  issueSummary: string;
  valuePreview: string;
  notePreview: string;
  targetTab: 'fields' | 'legal';
  fieldCode?: string;
  legalOrRelId?: string;
  relationSubTab?: 'legal' | 'relations';
}

export interface EntityProgressSummary {
  entityId: string;
  totalItems: number;
  draftCount: number;
  disputedCount: number;
  checkedCount: number;
  specialistCount: number;
  errorOrBlockingCount: number;
  pendingCount: number;
  applicableTotalCount: number;
  applicableUnstartedCount: number;
}

export interface ChainConsistencyCheck {
  code: string;
  severity: 'pass' | 'warning' | 'error';
  message: string;
}

export interface ChainEvidenceEntry {
  id: string;
  sourceId: string;
  sourceKind: 'violation' | 'cause' | 'liability' | 'field' | 'relation';
  sourceLabel: string;
  subjectId: string;
  page: number;
  quote: string;
}

export interface LegalEvidenceChain {
  anchorItem: LegalConclusionItem;
  violations: LegalConclusionItem[];
  causes: LegalConclusionItem[];
  liabilities: LegalConclusionItem[];
  subjectIds: string[];
  subjects: EntityItem[];
  partyFieldRecords: FieldRecord[];
  relatedRelations: EventRelationItem[];
  evidences: ChainEvidenceEntry[];
  consistencyChecks: ChainConsistencyCheck[];
}

export interface MatchedPdfParagraph {
  page: number;
  paragraphIndex: number;
  text: string;
  matchedEvidences: ChainEvidenceEntry[];
}

export interface ViolationVocabMatch {
  vocabKey: string;
  fieldCode: string;
  fieldName: string;
  codeTable: string;
  standardTerm: string;
  matchedBy: string;
  isPrimaryStandard: boolean;
  isLinked: boolean;
}

export interface ViolationEntityMatch {
  entityId: string;
  entityKind: EntityKind;
  entityLabel: string;
  matchedAlias: string;
  isCurrentSubject: boolean;
  isCurrentEvent: boolean;
  isLinked: boolean;
}

export interface ViolationLinkScanResult {
  vocabMatches: ViolationVocabMatch[];
  entityMatches: ViolationEntityMatch[];
  hasAnyMatch: boolean;
  hasUnlinkedMatch: boolean;
  hasSubjectMismatch: boolean;
  isConfirmed: boolean;
  needsConfirmationError: boolean;
  fingerprint: string;
}



