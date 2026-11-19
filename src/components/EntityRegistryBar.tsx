import React, { useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { ENTITY_KIND_META } from '../data/schemaCatalog';
import { EntityItem, EntityKind, EntityProgressSummary } from '../types/gold';

interface EntityRegistryBarProps {
  entities: EntityItem[];
  selectedEntityId: string;
  onSelectEntity: (entityId: string) => void;
  onAddEntity: (kind: EntityKind, label: string, subtitle: string) => void;
  onRemoveEntity: (entityId: string) => void;
  recordCountByEntity: Record<string, number>;
  progressByEntity?: Record<string, EntityProgressSummary>;
}

const ORDERED_KINDS: EntityKind[] = ['ACC', 'P', 'V', 'E', 'R', 'I', 'O'];

export const EntityRegistryBar: React.FC<EntityRegistryBarProps> = ({
  entities,
  selectedEntityId,
  onSelectEntity,
  onAddEntity,
  onRemoveEntity,
  recordCountByEntity,
  progressByEntity,
}) => {
  const [addingOpen, setAddingOpen] = useState(false);
  const [newKind, setNewKind] = useState<EntityKind>('P');
  const [newLabel, setNewLabel] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');

  const selected = entities.find(entity => entity.id === selectedEntityId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    onAddEntity(newKind, newLabel.trim(), newSubtitle.trim());
    setNewLabel('');
    setNewSubtitle('');
    setAddingOpen(false);
  };

  return (
    <div className="border-b border-slate-200 bg-white px-4 py-2.5">
      <div className="flex items-center gap-3">
        <h2 className="shrink-0 text-xs text-slate-600">本案对象</h2>
        <Popover.Root>
          <Popover.Trigger aria-label={`选择本案对象：${selected?.label || selectedEntityId}`} className="inline-flex min-w-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs hover:bg-slate-50">
            <span className="font-mono-tabular text-slate-500">{selectedEntityId}</span>
            <span className="truncate font-medium text-slate-900">{selected?.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-slate-500" aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="start" sideOffset={4} collisionPadding={10} className="z-50">
              <Popover.Popup aria-label="已登记对象" className="max-h-[min(24rem,var(--available-height))] w-[min(25rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-md">
                {ORDERED_KINDS.map(kind => {
                  const members = entities.filter(entity => entity.kind === kind);
                  if (!members.length) return null;
                  return (
                    <div key={kind} role="group" aria-label={ENTITY_KIND_META[kind].label}>
                      <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-slate-500">{ENTITY_KIND_META[kind].label}</div>
                      {members.map(entity => {
                        const active = entity.id === selectedEntityId;
                        const count = recordCountByEntity[entity.id] ?? 0;
                        const progress = progressByEntity?.[entity.id];
                        const pending = progress?.pendingCount ?? 0;
                        const unstarted = progress?.applicableUnstartedCount ?? 0;
                        return (
                          <div key={entity.id} className={`flex items-center rounded ${active ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                            <Popover.Close onClick={() => onSelectEntity(entity.id)} aria-current={active || undefined} className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-xs">
                              <span className="w-7 shrink-0 font-mono-tabular text-slate-500">{entity.id}</span>
                              <span className="flex-1 break-words text-slate-900">{entity.label}</span>
                              <span className="whitespace-nowrap text-[11px] text-slate-500">{count} 项</span>
                              {pending > 0 ? <span className={`whitespace-nowrap text-[11px] ${progress?.disputedCount ? 'text-red-700' : 'text-amber-700'}`}>待处理 {pending}</span>
                                : unstarted > 0 ? <span className="whitespace-nowrap text-[11px] text-slate-500">未填 {unstarted}</span>
                                : count > 0 && <span className="whitespace-nowrap text-[11px] text-emerald-700">已清</span>}
                              {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                            </Popover.Close>
                            {entity.kind !== 'ACC' && (
                              <button type="button" aria-label={`删除对象 ${entity.id} ${entity.label}`} onClick={() => onRemoveEntity(entity.id)} className="mr-1 rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700">
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <button
          type="button"
          aria-expanded={addingOpen}
          onClick={() => setAddingOpen((v) => !v)}
          className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          登记对象
        </button>
      </div>

      {addingOpen && (
        <form
          onSubmit={handleSubmit}
          className="mt-3 grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-12"
        >
          <div className="sm:col-span-3">
            <label htmlFor="new-entity-kind" className="mb-1 block text-xs font-medium text-slate-700">
              对象类型
            </label>
            <select
              id="new-entity-kind"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as EntityKind)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
            >
              {ORDERED_KINDS.filter((k) => k !== 'ACC').map((k) => (
                <option key={k} value={k}>
                  {ENTITY_KIND_META[k].label} ({ENTITY_KIND_META[k].prefix}01+)
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-4">
            <label htmlFor="new-entity-label" className="mb-1 block text-xs font-medium text-slate-700">
              名称 / 标识
            </label>
            <input
              id="new-entity-label"
              type="text"
              required
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="如：乘客1 / 苏A3F982 / 第一阶段"
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>
          <div className="sm:col-span-3">
            <label htmlFor="new-entity-subtitle" className="mb-1 block text-xs font-medium text-slate-700">
              主体角色 / 说明
            </label>
            <input
              id="new-entity-subtitle"
              type="text"
              value={newSubtitle}
              onChange={(e) => setNewSubtitle(e.target.value)}
              placeholder="如：机动车驾驶人 / 事故车辆"
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>
          <div className="flex items-end gap-1.5 sm:col-span-2">
            <button
              type="submit"
              className="w-full whitespace-nowrap rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
            >
              确认新增
            </button>
          </div>
        </form>
      )}

    </div>
  );
};
