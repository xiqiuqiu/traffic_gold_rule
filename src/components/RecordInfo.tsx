import { Popover } from '@base-ui/react/popover';
import { Info } from 'lucide-react';

export function RecordInfo({ label, rows }: { label: string; rows: [string, string | undefined][] }) {
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover closeDelay={160} aria-label={label} onClick={event => event.stopPropagation()}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-blue-700">
        <Info className="size-3.5" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} collisionPadding={10} className="z-50">
          <Popover.Popup aria-label={label} onClick={event => event.stopPropagation()} className="max-w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-md">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              {rows.map(([name, value]) => value && <div key={name} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-slate-500">{name}</dt><dd className="break-words text-slate-800">{value}</dd>
              </div>)}
            </dl>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
