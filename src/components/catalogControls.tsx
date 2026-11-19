import type { ComponentProps } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';

export const Dialog = BaseDialog.Root;
export const DialogHeader = 'div';
export function DialogTitle({ children }: ComponentProps<typeof BaseDialog.Title>) {
  return <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
    <BaseDialog.Title className="text-sm font-semibold">{children}</BaseDialog.Title>
    <BaseDialog.Close aria-label="关闭窗口" className="rounded p-1 text-slate-500 hover:bg-slate-100">
      <X className="h-4 w-4" aria-hidden="true" />
    </BaseDialog.Close>
  </div>;
}
export function DialogDescription({ children }: ComponentProps<typeof BaseDialog.Description>) {
  return <BaseDialog.Description className="mt-3 text-xs leading-relaxed text-slate-600">{children}</BaseDialog.Description>;
}
export function DialogContent({ children }: ComponentProps<'div'>) {
  return <BaseDialog.Portal>
    <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/35" />
    <BaseDialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(26rem,94vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-auto rounded-lg border border-slate-200 bg-white p-5 text-slate-900 shadow-lg">
      {children}
    </BaseDialog.Popup>
  </BaseDialog.Portal>;
}
export function DialogFooter({ children }: ComponentProps<'div'>) {
  return <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">{children}</div>;
}

const buttonStyles = {
  default: 'bg-blue-700 text-white hover:bg-blue-800',
  outline: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
  destructive: 'bg-red-700 text-white hover:bg-red-800',
};
export function Button({ variant = 'default', className = '', ...props }: ComponentProps<'button'> & {
  variant?: keyof typeof buttonStyles;
}) {
  return <button type="button" {...props} className={`inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`} />;
}
const fieldStyle = 'min-w-0 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:border-blue-600 focus:outline-blue-600 disabled:bg-slate-50';
export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`w-full ${fieldStyle} ${className}`} />;
}
export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`${fieldStyle} ${className}`} />;
}
export function Table({ className = '', ...props }: ComponentProps<'table'>) {
  return <table {...props} className={`w-full border-collapse text-left text-xs [&_td]:px-3 [&_td]:py-2 [&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold [&_th]:text-slate-600 [&_tbody_tr]:border-b [&_tbody_tr]:border-slate-100 ${className}`} />;
}
export const TableHead = 'th';
export const TableHeader = 'thead';
export const TableCell = 'td';
export const TableBody = 'tbody';
export const TableRow = 'tr';
