import type { CaseDocument } from '../types/gold';
import type { AnalysisTask } from '../types/system';

export function createPlaceholderCaseForTask(task: AnalysisTask): CaseDocument {
  return {
    caseId: task.caseId,
    documentId: task.caseId.toLowerCase(),
    title: `${task.caseId} · ${task.filename.replace(/\.pdf$/i, '')}`,
    pilotCode: task.source === 'scheduled_batch' ? '定时批量' : '手工上传',
    scenarioSummary:
      task.source === 'scheduled_batch'
        ? `由定时批量扫盘自动入库的案件材料（${task.filename}）。`
        : `由人工手动上传创建的案件材料（${task.filename}）。`,
    pdfUrl: task.pdfUrl,
    sourceFilename: task.filename,
    fileSha256: task.fileSha256,
    pageCount: task.pageCount || 1,
    manualVersion: '试行版 · 首批6份',
    annotationVersion: 'v1.0',
    maskPiiOnExport: true,
    annotatorName: task.createdByName || '第一标注人',
    reviewerName: '第二复核人',
    adjudicatorName: '',
    entities: [
      {
        id: 'ACC',
        kind: 'ACC',
        label: '整起事故',
        subtitle: task.filename,
        roleLabel: '事故主体',
      },
    ],
    fieldRecords: [],
    legalConclusions: [],
    relations: [],
    checklist: {},
    auditLog: [],
  };
}
