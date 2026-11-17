import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    onAddEntity(newKind, newLabel.trim(), newSubtitle.trim());
    setNewLabel('');
    setNewSubtitle('');
    setAddingOpen(false);
  };

  return (
    <div className="border-b border-slate-200 bg-white px-5 pt-4 pb-2.5">
      <div className="mb-2.5 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-slate-900">本案对象</h2>
        <button
          type="button"
          onClick={() => setAddingOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          登记对象
        </button>
      </div>

      {addingOpen && (
        <form
          onSubmit={handleSubmit}
          className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-12"
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
              主体角色 / 说明 (subjects.role)
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
              className="w-full whitespace-nowrap rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              确认新增
            </button>
          </div>
        </form>
      )}

      {/* Entity selector tabs: clean segmented strip with bottom indicator instead of bordered boxes */}
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="已登记对象列表">
        {entities.map((entity) => {
          const isSelected = entity.id === selectedEntityId;
          const count = recordCountByEntity[entity.id] ?? 0;
          const prog = progressByEntity?.[entity.id];
          const pending = prog?.pendingCount ?? 0;
          const disputed = prog?.disputedCount ?? 0;
          const unstarted = prog?.applicableUnstartedCount ?? 0;

          return (
            <div
              key={entity.id}
              className={`group flex items-center rounded-md transition-colors ${
                isSelected
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100/80 text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => onSelectEntity(entity.id)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
              >
                <span
                  className={`font-mono-tabular font-semibold ${
                    isSelected ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  {entity.id}
                </span>
                <span className="max-w-[150px] truncate font-medium">{entity.label}</span>
                <span
                  className={`font-mono-tabular ${
                    isSelected ? 'text-slate-300' : 'text-slate-400'
                  }`}
                >
                  {count}
                </span>
                {pending > 0 ? (
                  <span
                    className={`font-mono-tabular font-medium ${
                      isSelected
                        ? disputed > 0
                          ? 'text-red-300'
                          : 'text-amber-300'
                        : disputed > 0
                          ? 'text-red-700'
                          : 'text-amber-700'
                    }`}
                  >
                    · 待{pending}
                  </span>
                ) : unstarted > 0 ? (
                  <span
                    className={`font-mono-tabular ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    · 未填{unstarted}
                  </span>
                ) : count > 0 ? (
                  <span
                    className={`font-medium ${
                      isSelected ? 'text-emerald-300' : 'text-emerald-700'
                    }`}
                  >
                    · 已清
                  </span>
                ) : null}
              </button>
              {entity.kind !== 'ACC' && (
                <button
                  type="button"
                  aria-label={`删除对象 ${entity.id} ${entity.label}`}
                  onClick={() => onRemoveEntity(entity.id)}
                  className={`mr-1 rounded p-1 opacity-70 hover:opacity-100 ${
                    isSelected
                      ? 'text-slate-300 hover:bg-slate-800 hover:text-red-300'
                      : 'text-slate-400 hover:bg-red-50 hover:text-red-700'
                  }`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
