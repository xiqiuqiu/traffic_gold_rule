import { Menu } from '@base-ui/react/menu';
import { Link2, Plus } from 'lucide-react';
import type { LegalConclusionItem } from '../types/gold';

interface LinkCauseMenuProps {
  violation: LegalConclusionItem;
  causes: LegalConclusionItem[];
  onSave: (cause: LegalConclusionItem, auditNote: string) => void;
  onCreate: () => void;
}

const itemClass = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-slate-100 data-disabled:cursor-default data-disabled:text-slate-500';

export function LinkCauseMenu({ violation, causes, onSave, onCreate }: LinkCauseMenuProps) {
  const candidates = causes.filter(cause => cause.subjectId === violation.subjectId);
  return (
    <Menu.Root>
      <Menu.Trigger onClick={event => event.stopPropagation()}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-blue-700 hover:underline focus-visible:underline">
        <Link2 className="size-3" aria-hidden="true" />关联认定原因
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup aria-label="关联认定原因" onClick={event => event.stopPropagation()}
            className="max-h-[var(--available-height)] w-64 max-w-[var(--available-width)] overflow-y-auto rounded-md border border-slate-200 bg-white p-1 text-xs text-slate-700 shadow-md">
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1.5 text-slate-500">
                {violation.subjectId} · {candidates.length ? '已有认定原因' : '暂无认定原因'}
              </Menu.GroupLabel>
              {candidates.map(cause => {
                const linked = cause.linkedViolationIds?.includes(violation.id);
                return (
                  <Menu.Item key={cause.id} disabled={linked} className={itemClass} onClick={() => {
                    onSave({
                      ...cause,
                      causalLinkStatus: !cause.causalLinkStatus || cause.causalLinkStatus === 'unspecified'
                        ? 'explicit_linked' : cause.causalLinkStatus,
                      linkedViolationIds: [...(cause.linkedViolationIds || []), violation.id],
                    }, `关联违法记录 ${violation.id} 至认定原因 ${cause.id}`);
                  }}>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{cause.conclusionLabel || cause.rawText || '待填写原因'}</span>
                      <span className="text-slate-500">{cause.eventId || '整起事故'} · {cause.id}</span>
                    </span>
                    {linked && <span className="shrink-0 text-slate-500">已关联</span>}
                  </Menu.Item>
                );
              })}
            </Menu.Group>
            <Menu.Separator className="my-1 border-t border-slate-100" />
            <Menu.Item className={itemClass} onClick={onCreate}>
              <Plus className="size-3.5" aria-hidden="true" />新建认定原因并关联
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
