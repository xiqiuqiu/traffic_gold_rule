import { Popover } from '@base-ui/react/popover';
import { Info } from 'lucide-react';
import type { CaseDocument } from '../types/gold';
import { extractAccidentBizId } from '../utils/systemEngine';

export function CaseHeading({ caseDoc, taskId, title }: { caseDoc: CaseDocument; taskId?: string; title: string }) {
  const { caseId, documentId, sourceHashFull, fileSha256 } = caseDoc;
  const details = [
    ['事故业务编号', extractAccidentBizId(caseDoc) || '待补充'],
    ['任务 ID', taskId],
    ['案件 ID', caseId],
    ['文档 ID', documentId],
    ['SHA-256', sourceHashFull || fileSha256.replace(/^sha256:/, '')],
  ];

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h1 className="truncate text-sm font-semibold text-slate-900" title={title}>{title}</h1>
      <Popover.Root>
        <Popover.Trigger openOnHover closeDelay={180} aria-label="案件信息" className="inline-flex size-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-blue-700 data-popup-open:bg-slate-100">
          <Info className="size-4" aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="start" sideOffset={6} collisionPadding={12} className="z-50">
            <Popover.Popup className="w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-900 shadow-md">
              <Popover.Title className="mb-3 font-semibold">案件信息</Popover.Title>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                {details.filter(([, value]) => value).map(([label, value]) => (
                  <div key={label} className="col-span-2 grid grid-cols-subgrid items-baseline">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="select-text break-all font-mono-tabular">{value}</dd>
                  </div>
                ))}
              </dl>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
