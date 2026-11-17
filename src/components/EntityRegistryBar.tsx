import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ENTITY_KIND_META } from '../data/schemaCatalog';
import { EntityItem, EntityKind } from '../types/gold';

interface EntityRegistryBarProps {
  entities: EntityItem[];
  selectedEntityId: string;
  onSelectEntity: (entityId: string) => void;
  onAddEntity: (kind: EntityKind, label: string, subtitle: string) => void;
  onRemoveEntity: (entityId: string) => void;
  recordCountByEntity: Record<string, number>;
}

const ORDERED_KINDS: EntityKind[] = ['ACC', 'P', 'V', 'E', 'R', 'I', 'O'];

export const EntityRegistryBar: React.FC<EntityRegistryBarProps> = ({
  entities,
  selectedEntityId,
  onSelectEntity,
  onAddEntity,
  onRemoveEntity,
  recordCountByEntity,
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
    <div className="border-b border-slate-200 bg-white px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            步骤 2 · 本案对象登记表
          </h2>
          <p className="text-xs text-slate-500">
            先列清真正出现的对象再标字段；选中对象后仅显示该对象适用字段，防止挂错主体。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddingOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
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
              补充说明（可选）
            </label>
            <input
              id="new-entity-subtitle"
              type="text"
              value={newSubtitle}
              onChange={(e) => setNewSubtitle(e.target.value)}
              placeholder="如：轻伤 / 挂靠公司"
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

      {/* Entity selector grid */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="已登记对象列表">
        {entities.map((entity) => {
          const isSelected = entity.id === selectedEntityId;
          const count = recordCountByEntity[entity.id] ?? 0;
          return (
            <div
              key={entity.id}
              className={`group flex items-center rounded-md border transition-colors ${
                isSelected
                  ? 'border-blue-700 bg-blue-50/70 text-blue-950'
                  : 'border-slate-200 bg-slate-50/60 text-slate-700 hover:border-slate-300 hover:bg-white'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => onSelectEntity(entity.id)}
                className="flex items-center gap-2 px-2.5 py-1.5 text-left text-xs"
              >
                <span className="font-mono-tabular font-semibold text-blue-800">
                  {entity.id}
                </span>
                <span className="max-w-[160px] truncate font-medium">{entity.label}</span>
                <span className="font-mono-tabular text-slate-400">· {count}</span>
              </button>
              {entity.kind !== 'ACC' && (
                <button
                  type="button"
                  aria-label={`删除对象 ${entity.id} ${entity.label}`}
                  onClick={() => onRemoveEntity(entity.id)}
                  className="mr-1 rounded p-1 text-slate-400 opacity-70 hover:bg-red-50 hover:text-red-700 hover:opacity-100"
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
