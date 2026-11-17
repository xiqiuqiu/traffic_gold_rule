import React from 'react';
import { AlertTriangle, Check, CircleDashed, Clock, Scale } from 'lucide-react';
import { REVIEW_STATUS_META } from '../data/schemaCatalog';
import { ReviewStatus } from '../types/gold';

interface ReviewLifecycleBarProps {
  reviewStatus?: ReviewStatus;
  hasError?: boolean;
  compact?: boolean;
  disputeReason?: string;
  adjudicatorNote?: string;
}

export function getCardStatusBorderClass(
  reviewStatus: ReviewStatus | undefined,
  hasError: boolean,
  isFocused: boolean,
): string {
  if (isFocused) {
    return 'border-slate-900 bg-white ring-1 ring-slate-900/10';
  }
  if (hasError || reviewStatus === 'disputed') {
    return 'border-red-300 bg-white hover:border-red-400';
  }
  return 'border-slate-200 bg-white hover:border-slate-300';
}

export const ReviewLifecycleBar: React.FC<ReviewLifecycleBarProps> = ({
  reviewStatus,
  hasError = false,
  compact = false,
  disputeReason,
  adjudicatorNote,
}) => {
  if (!reviewStatus) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-400">
        <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
        <span>未开始</span>
      </span>
    );
  }

  const meta = REVIEW_STATUS_META[reviewStatus];

  const statusMeta = (() => {
    if (reviewStatus === 'disputed') {
      return {
        label: '争议中 · 待裁定',
        cls: 'text-red-700',
        icon: <AlertTriangle className="h-3.5 w-3.5 text-red-700" aria-hidden="true" />,
      };
    }
    if (reviewStatus === 'specialist_review') {
      return {
        label: '专业裁定 · 已终审',
        cls: 'text-blue-800',
        icon: <Scale className="h-3.5 w-3.5 text-blue-700" aria-hidden="true" />,
      };
    }
    if (reviewStatus === 'checked') {
      return {
        label: '已复核 · 一致通过',
        cls: 'text-emerald-800',
        icon: <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />,
      };
    }
    return {
      label: '草稿 · 待复核',
      cls: 'text-amber-800',
      icon: <Clock className="h-3.5 w-3.5 text-amber-700" aria-hidden="true" />,
    };
  })();

  if (compact) {
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap text-xs font-medium ${statusMeta.cls}`}
        >
          {statusMeta.icon}
          <span>{statusMeta.label}</span>
        </span>
        {(disputeReason || adjudicatorNote) && (
          <span className="max-w-[260px] truncate text-xs text-slate-500">
            {disputeReason ? `争议：${disputeReason}` : `裁定：${adjudicatorNote}`}
          </span>
        )}
      </div>
    );
  }

  const step2Label = reviewStatus === 'disputed' ? '复核争议' : '复核';
  const step1Cls =
    reviewStatus === 'draft' ? 'font-semibold text-slate-900' : 'text-slate-500';
  const step2Cls =
    reviewStatus === 'disputed'
      ? 'font-semibold text-red-700'
      : reviewStatus === 'checked' || reviewStatus === 'specialist_review'
        ? 'font-medium text-slate-700'
        : 'text-slate-300';
  const step3Cls =
    reviewStatus === 'specialist_review'
      ? 'font-semibold text-blue-800'
      : reviewStatus === 'disputed'
        ? 'font-medium text-slate-700'
        : 'text-slate-300';

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-label={`流转阶段：${meta.label}`}
          className="hidden items-center gap-1 text-xs sm:inline-flex"
        >
          <span className={step1Cls}>草稿</span>
          <span className="text-slate-300" aria-hidden="true">
            →
          </span>
          <span className={step2Cls}>{step2Label}</span>
          <span className="text-slate-300" aria-hidden="true">
            →
          </span>
          <span className={step3Cls}>裁定</span>
        </span>

        <span
          className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold ${statusMeta.cls}`}
        >
          {statusMeta.icon}
          <span>{statusMeta.label}</span>
        </span>
      </div>
      {hasError && (
        <span className="text-[11px] font-medium text-red-700">
          存在必填项或阻断状态待补齐
        </span>
      )}
    </div>
  );
};
