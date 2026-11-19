import React, { useEffect, useState } from 'react';
import { CheckCircle2, RotateCcw, Shield, Sliders, UserCheck } from 'lucide-react';
import {
  ExtendedRole,
  PermissionKey,
  RolePermissionMatrix,
  UserIdentityProfile,
} from '../types/system';
import {
  DEFAULT_ROLE_PERMISSIONS,
  EXTENDED_ROLE_META,
  PERMISSION_CATALOG,
} from '../utils/systemEngine';
import { AiProviderSettings } from '../utils/aiSettings';
import { ModelSettingsPanel } from './ModelSettingsPanel';

interface PermissionsPanelProps {
  identities: UserIdentityProfile[];
  activeIdentity: UserIdentityProfile;
  rolePermissions: RolePermissionMatrix;
  canEditPermissions: boolean;
  aiSettings: AiProviderSettings;
  subTabRequest?: { tab: 'rbac' | 'model'; nonce: number } | null;
  onSwitchIdentity: (identityId: string) => void;
  onUpdatePermissions: (next: RolePermissionMatrix, changeSummary: string) => Promise<void>;
  settingsReady: boolean;
  hasServerKey: boolean;
  onSaveAiSettings: (next: AiProviderSettings) => Promise<void>;
  onJumpToPreanalyze: () => void;
}

const ORDERED_ROLES: ExtendedRole[] = ['admin', 'annotator', 'reviewer', 'adjudicator', 'viewer'];

export const PermissionsPanel: React.FC<PermissionsPanelProps> = ({
  identities,
  activeIdentity,
  rolePermissions,
  canEditPermissions,
  aiSettings,
  subTabRequest,
  onSwitchIdentity,
  onUpdatePermissions,
  settingsReady,
  hasServerKey,
  onSaveAiSettings,
  onJumpToPreanalyze,
}) => {
  const [subTab, setSubTab] = useState<'rbac' | 'model'>('rbac');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (subTabRequest) {
      setSubTab(subTabRequest.tab);
    }
  }, [subTabRequest]);

  const handleToggleCell = async (role: ExtendedRole, permKey: PermissionKey) => {
    if (!canEditPermissions) return;
    // Safeguard: keep admin's permission management ability active to avoid self-lockout
    if (role === 'admin' && permKey === 'system:audit_permissions') return;
    const currentVal = Boolean(rolePermissions[role]?.[permKey]);
    const next: RolePermissionMatrix = {
      ...rolePermissions,
      [role]: {
        ...rolePermissions[role],
        [permKey]: !currentVal,
      },
    };
    const permLabel = PERMISSION_CATALOG.find((p) => p.key === permKey)?.label || permKey;
    const roleLabel = EXTENDED_ROLE_META[role].label;
    setSaving(true);
    try {
      await onUpdatePermissions(
        next,
        `${!currentVal ? '授予' : '收回'}「${roleLabel}」的「${permLabel}」权限`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    if (!canEditPermissions) return;
    setSaving(true);
    try {
      await onUpdatePermissions(DEFAULT_ROLE_PERMISSIONS, '恢复默认五角色权限矩阵');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-5">
      {/* Sub-navigation between RBAC & Model Connection Settings */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 rounded-md bg-slate-200/70 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setSubTab('rbac')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 font-medium transition-colors ${
              subTab === 'rbac' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Shield className="h-3.5 w-3.5" aria-hidden="true" />
            快捷身份切换与角色权限矩阵
          </button>
          <button
            type="button"
            onClick={() => setSubTab('model')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 font-medium transition-colors ${
              subTab === 'model' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
            大模型接入与探测设置
          </button>
        </div>

        <span className="text-xs text-slate-500">
          当前活跃身份：<strong className="text-slate-900">{activeIdentity.name}</strong> ·{' '}
          {EXTENDED_ROLE_META[activeIdentity.role].label}
        </span>
      </div>

      {subTab === 'model' ? (
        <div className="rounded-lg border border-slate-200 bg-white">
          <ModelSettingsPanel
            settings={aiSettings}
            ready={settingsReady}
            canManage={canEditPermissions}
            actorRole={activeIdentity.role}
            hasServerKey={hasServerKey}
            onSaveSettings={onSaveAiSettings}
            onJumpToPreanalyze={onJumpToPreanalyze}
          />
        </div>
      ) : (
        <>
          {/* Quick Identity Switcher Cards (No full login required per user decision) */}
          <section
            aria-label="演示快捷身份切换"
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <UserCheck className="h-4 w-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">快捷演示身份切换</h2>
                <span className="text-xs text-slate-500">
                  · 现阶段免账号登录校验，一键切换五类业务角色实时验证权限拦截效果
                </span>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {identities.map((idProfile) => {
                const active = idProfile.id === activeIdentity.id;
                const roleMeta = EXTENDED_ROLE_META[idProfile.role];
                return (
                  <button
                    key={idProfile.id}
                    type="button"
                    onClick={() => onSwitchIdentity(idProfile.id)}
                    className={`flex flex-col items-start justify-between rounded-md border p-3 text-left transition-colors ${
                      active
                        ? 'border-blue-700 bg-blue-50/40'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="w-full">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900">
                          {roleMeta.label}
                        </span>
                        {active && (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-blue-700" aria-hidden="true" />
                        )}
                      </div>
                      <div className="mt-1 text-xs font-medium text-slate-800">{idProfile.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {idProfile.department} · {idProfile.title}
                      </div>
                    </div>
                    <p className="mt-2.5 text-[11px] leading-relaxed text-slate-600">
                      {roleMeta.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Editable RBAC Matrix */}
          <section
            aria-label="角色功能权限矩阵配置"
            className="overflow-hidden rounded-lg border border-slate-200 bg-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">RBAC 角色权限矩阵</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  勾选或取消对应角色的权限点即时生效，并自动写入全链路审计日志（系统管理员权限管理权默认保留，防止误锁）。
                </p>
              </div>
              <button
                type="button"
                disabled={!canEditPermissions || saving}
                onClick={handleResetDefaults}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                恢复默认矩阵
              </button>
            </div>

            {!canEditPermissions && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                当前身份无「审计日志与权限管理」权限，矩阵复选框已只读锁定；请点击上方「系统管理员」快捷切换后再试。
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                    <th className="px-4 py-2.5 font-medium">权限点与控制范围</th>
                    {ORDERED_ROLES.map((r) => (
                      <th key={r} className="px-4 py-2.5 text-center font-medium">
                        <div>{EXTENDED_ROLE_META[r].label}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {PERMISSION_CATALOG.map((perm) => (
                    <tr key={perm.key} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{perm.label}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">{perm.description}</div>
                      </td>
                      {ORDERED_ROLES.map((r) => {
                        const checked = Boolean(rolePermissions[r]?.[perm.key]);
                        const lockedAdmin =
                          r === 'admin' && perm.key === 'system:audit_permissions';
                        return (
                          <td key={r} className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${EXTENDED_ROLE_META[r].label}-${perm.label}`}
                              checked={checked}
                              disabled={!canEditPermissions || saving || lockedAdmin}
                              onChange={() => handleToggleCell(r, perm.key)}
                              className="h-4 w-4 cursor-pointer accent-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
