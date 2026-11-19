import type { ReactNode } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import type { LucideIcon } from 'lucide-react';

export function WorkbenchPage({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-5 max-sm:px-3">{children}</div>;
}

export function WorkbenchPageTabs<T extends string>({ label, items, value, onChange, aside, children }: {
  label: string;
  items: readonly { value: T; label: string; icon: LucideIcon }[];
  value: T;
  onChange: (value: T) => void;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tabs.Root value={value} onValueChange={onChange} className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <Tabs.List aria-label={label} className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-slate-200/70 p-0.5 text-xs">
          {items.map(({ value: key, label, icon: Icon }) => (
            <Tabs.Tab key={key} value={key} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 font-medium text-slate-600 transition-colors hover:text-slate-900 data-active:bg-white data-active:text-slate-900 data-active:shadow-xs">
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {aside}
      </div>
      <Tabs.Panel key={value} value={value} className="flex min-w-0 flex-col gap-5">{children}</Tabs.Panel>
    </Tabs.Root>
  );
}
