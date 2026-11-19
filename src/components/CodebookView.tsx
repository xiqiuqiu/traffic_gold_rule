import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ClipboardCheck, ListTree, Search, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Select,
} from './catalogControls';
import { WorkbenchPage, WorkbenchPageTabs } from './WorkbenchPage';
import { api } from '../utils/catalogApi';
import type { ObservationReport, ObservationRow, ReviewStatus } from '../types/catalog';

const PAGE_SIZE = 40;

interface CodeGroup {
  authority: string;
  legal: boolean;
  fields: { code: string; name: string }[];
  count: number;
}

interface UnboundField {
  code: string;
  name: string;
  reason: string;
}

interface CodeRow {
  dmz: string;
  label: string;
  aliases?: string[];
}

interface ReadingGroup {
  name: string;
  authority: string;
  members: { dmz: string; label: string }[];
}

interface ExtensionTag {
  extCode: string;
  fieldCode: string;
  fieldName: string;
  label: string;
  aliases: string[];
}

interface CodebookViewProps {
  userId: string;
  canManage: boolean;
}

function fieldNames(group: CodeGroup): string {
  return group.fields.map((field) => field.name).join('、');
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function splitCodes(text: string): string[] {
  return text
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function memberSpan(members: { dmz: string }[]): string {
  if (members.length === 0) return '';
  if (members.length <= 2) return members.map((member) => member.dmz).join(', ');
  return `${members[0].dmz}..${members[members.length - 1].dmz}`;
}

function percent(value: number, hasReviewed: boolean): string {
  if (!hasReviewed) return '暂无';
  return `${Math.round(value * 1000) / 10}%`;
}

const VIA_LABEL: Record<string, string> = {
  dmz: '标准代码',
  label: '标准名称',
  alias: '同义读法',
  group: '上位分组',
  extension: '扩充标签',
  none: '没有命中',
};

export function CodebookView({ userId, canManage }: CodebookViewProps) {
  const [tab, setTab] = useState<'codes' | 'observations' | 'extensions'>('codes');
  return (
    <WorkbenchPage>
      <WorkbenchPageTabs<typeof tab>
        label="标签库"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'codes', label: '通行标准码与读法', icon: BookOpen },
          { value: 'observations', label: '表外观察与权重评估', icon: ClipboardCheck },
          { value: 'extensions', label: '本系统扩充标签', icon: Tags },
        ]}
        aside={canManage ? undefined : <span className="text-xs text-slate-500">当前身份：只读</span>}
      >
        {tab === 'codes' && <CodesPanel userId={userId} canManage={canManage} />}
        {tab === 'observations' && <ObservationsPanel userId={userId} canManage={canManage} />}
        {tab === 'extensions' && <ExtensionsPanel userId={userId} canManage={canManage} />}
      </WorkbenchPageTabs>
    </WorkbenchPage>
  );
}

function CodesPanel({ userId, canManage }: CodebookViewProps) {
  const [groups, setGroups] = useState<CodeGroup[]>([]);
  const [unbound, setUnbound] = useState<UnboundField[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [section, setSection] = useState<'codes' | 'groups'>('codes');
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [dmz, setDmz] = useState('');
  const [label, setLabel] = useState('');
  const [ready, setReady] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CodeRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasPhrase, setAliasPhrase] = useState('');
  const [pendingAlias, setPendingAlias] = useState<{ dmz: string; phrase: string } | null>(null);
  const [readings, setReadings] = useState<ReadingGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState('');
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [pendingGroup, setPendingGroup] = useState<string | null>(null);
  const [expandField, setExpandField] = useState('');
  const [expandTerm, setExpandTerm] = useState('');
  const [expandText, setExpandText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const codesRef = useRef<CodeRow[]>([]);
  const totalRef = useRef(0);
  codesRef.current = codes;
  totalRef.current = total;

  const reloadReadings = useCallback(
    (authority: string) => {
      api
        .getReadings(userId, authority)
        .then((book) => setReadings(book.groups))
        .catch((err) => toast.error(errorText(err, '加载读法失败')));
    },
    [userId],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getCodebook(userId)
      .then((book) => {
        if (cancelled) return;
        setGroups(book.groups);
        setUnbound(book.unbound);
        setSelected((current) => {
          if (current && book.groups.some((group) => group.authority === current)) return current;
          return book.groups[0]?.authority ?? null;
        });
        setReady(true);
      })
      .catch((err) => {
        if (!cancelled) toast.error(errorText(err, '加载标签库失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!selected) {
      setReadings([]);
      return;
    }
    reloadReadings(selected);
  }, [selected, reloadReadings]);

  useEffect(() => {
    if (!selected) {
      setCodes([]);
      setTotal(0);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    loadingRef.current = true;
    setCodes([]);
    setTotal(0);
    setLoadingPage(true);
    api
      .getCodes(userId, selected, { q: appliedQuery, offset: 0, limit: PAGE_SIZE })
      .then((page) => {
        if (requestId !== requestRef.current) return;
        setCodes(page.codes);
        setTotal(page.total);
      })
      .catch((err) => {
        if (requestId === requestRef.current) toast.error(errorText(err, '加载代码失败'));
      })
      .finally(() => {
        if (requestId !== requestRef.current) return;
        loadingRef.current = false;
        setLoadingPage(false);
      });
  }, [userId, selected, appliedQuery]);

  const loadMore = useCallback(() => {
    if (!selected || loadingRef.current) return;
    if (codesRef.current.length >= totalRef.current) return;
    const requestId = requestRef.current;
    const offset = codesRef.current.length;
    loadingRef.current = true;
    setLoadingPage(true);
    api
      .getCodes(userId, selected, { q: appliedQuery, offset, limit: PAGE_SIZE })
      .then((page) => {
        if (requestId !== requestRef.current) return;
        setCodes((current) => {
          const seen = new Set(current.map((row) => row.dmz));
          return [...current, ...page.codes.filter((row) => !seen.has(row.dmz))];
        });
        setTotal(page.total);
      })
      .catch((err) => {
        if (requestId === requestRef.current) toast.error(errorText(err, '加载代码失败'));
      })
      .finally(() => {
        if (requestId !== requestRef.current) return;
        loadingRef.current = false;
        setLoadingPage(false);
      });
  }, [appliedQuery, selected, userId]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || section !== 'codes') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: '160px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, codes.length, total, selected, section]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selected, appliedQuery]);

  const selectedGroup = groups.find((group) => group.authority === selected) ?? null;
  const lastCode = selectedGroup?.count === 1;

  useEffect(() => {
    setExpandField(selectedGroup?.fields[0]?.code ?? '');
  }, [selectedGroup]);

  const chooseGroup = (authority: string) => {
    setSelected(authority);
    setQuery('');
    setAppliedQuery('');
    setAliasFor(null);
    setEditingGroup(null);
    setGroupName('');
    setGroupMembers('');
  };

  const bumpCount = (authority: string, delta: number) => {
    setGroups((current) =>
      current.map((group) =>
        group.authority === authority ? { ...group, count: Math.max(0, group.count + delta) } : group,
      ),
    );
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      const row = await api.addCode(userId, selected, dmz, label);
      setDmz('');
      setLabel('');
      setQuery(row.dmz);
      setAppliedQuery(row.dmz);
      bumpCount(selected, 1);
      toast.success('已添加代码');
    } catch (err) {
      toast.error(errorText(err, '添加代码失败'));
    }
  };

  const handleRename = async (authority: string, code: string, next: string) => {
    try {
      const row = await api.renameCode(userId, authority, code, next);
      setCodes((current) => current.map((item) => (item.dmz === code ? { ...item, label: row.label } : item)));
      toast.success('已更新名称');
    } catch (err) {
      toast.error(errorText(err, '更新名称失败'));
      throw err;
    }
  };

  const confirmRemove = async () => {
    if (!selected || !pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.removeCode(userId, selected, pendingDelete.dmz);
      setCodes((current) => current.filter((row) => row.dmz !== pendingDelete.dmz));
      setTotal((current) => Math.max(0, current - 1));
      bumpCount(selected, -1);
      setPendingDelete(null);
      toast.success('已删除代码');
    } catch (err) {
      toast.error(errorText(err, '删除代码失败'));
    } finally {
      setDeleting(false);
    }
  };

  const submitAlias = async (code: string) => {
    if (!selected || !aliasPhrase.trim()) return;
    try {
      const row = await api.addAlias(userId, selected, aliasPhrase, code);
      setCodes((current) =>
        current.map((item) =>
          item.dmz === code ? { ...item, aliases: [...(item.aliases ?? []), row.phrase] } : item,
        ),
      );
      setAliasPhrase('');
      setAliasFor(null);
      toast.success('已添加同义读法');
    } catch (err) {
      toast.error(errorText(err, '添加同义读法失败'));
    }
  };

  const confirmRemoveAlias = async () => {
    if (!selected || !pendingAlias) return;
    try {
      await api.removeAlias(userId, selected, pendingAlias.phrase);
      setCodes((current) =>
        current.map((item) =>
          item.dmz === pendingAlias.dmz
            ? { ...item, aliases: (item.aliases ?? []).filter((phrase) => phrase !== pendingAlias.phrase) }
            : item,
        ),
      );
      setPendingAlias(null);
      toast.success('已删除同义读法');
    } catch (err) {
      toast.error(errorText(err, '删除同义读法失败'));
    }
  };

  const submitGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      await api.saveGroup(userId, selected, groupName, splitCodes(groupMembers));
      setGroupName('');
      setGroupMembers('');
      setEditingGroup(null);
      reloadReadings(selected);
      toast.success('已保存查询分组');
    } catch (err) {
      toast.error(errorText(err, '保存查询分组失败'));
    }
  };

  const confirmRemoveGroup = async () => {
    if (!selected || !pendingGroup) return;
    try {
      await api.removeGroup(userId, selected, pendingGroup);
      setPendingGroup(null);
      reloadReadings(selected);
      toast.success('已删除查询分组');
    } catch (err) {
      toast.error(errorText(err, '删除查询分组失败'));
    }
  };

  const runExpand = async (event: FormEvent) => {
    event.preventDefault();
    if (!expandField) return;
    try {
      const result = await api.expandQuery(userId, expandField, expandTerm);
      const hit = result.dmz.length > 0 ? result.dmz.join(', ') : result.extension ?? '';
      setExpandText(`${VIA_LABEL[result.via] ?? result.via}${hit ? `：${hit}` : ''}`);
    } catch (err) {
      toast.error(errorText(err, '试查失败'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <aside aria-label="码表目录" className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
          <h2 className="mb-2 flex items-center gap-2 border-b border-slate-100 pb-2 text-sm font-semibold text-slate-900">
            <ListTree className="h-4 w-4 text-blue-700" aria-hidden="true" />码表目录
          </h2>
          <Select value={selected ?? ''} aria-label="选择码表" onChange={event => chooseGroup(event.target.value)} className="w-full md:hidden">
            {groups.map(group => <option key={group.authority} value={group.authority}>{fieldNames(group)} · {group.count} 条</option>)}
          </Select>
          <div className="hidden space-y-0.5 md:block">
          {groups.map((group) => {
            const active = group.authority === selected;
            return (
              <button
                key={group.authority}
                type="button"
                onClick={() => chooseGroup(group.authority)}
                aria-pressed={active}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-x-1 rounded-md px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-50 aria-pressed:bg-slate-100 aria-pressed:font-semibold aria-pressed:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-500"
              >
                <span className="text-xs">{fieldNames(group)}</span>
                <span className="text-right font-mono-tabular text-[11px] font-normal text-slate-500">{group.count}</span>
                <span className="font-mono-tabular text-[11px] font-normal text-slate-500">{group.authority}</span>
                {group.legal && <span className="text-right text-[11px] font-normal text-amber-700">法律结论</span>}
              </button>
            );
          })}
          {ready && groups.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-slate-500">没有可维护的代码表</div>
          )}
          {!ready && <div className="px-3 py-8 text-center text-sm text-slate-500">正在加载标签库</div>}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col md:max-h-[max(30rem,calc(100vh-10rem))] rounded-lg border border-slate-200 bg-white p-4">
          {selectedGroup ? (
            <>
              <div className="shrink-0 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-blue-700" aria-hidden="true" />
                    <h2 className="text-sm font-semibold text-slate-900">{fieldNames(selectedGroup)}</h2>
                    <span className="font-mono-tabular text-xs text-slate-500">{selectedGroup.authority}</span>
                  </div>
                  <div className="inline-flex rounded-md bg-slate-100 p-0.5">
                    <button
                      type="button"
                      onClick={() => setSection('codes')}
                      aria-pressed={section === 'codes'}
                      className={`rounded px-2.5 py-1 text-xs font-medium ${
                        section === 'codes' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      标准代码
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('groups')}
                      aria-pressed={section === 'groups'}
                      className={`rounded px-2.5 py-1 text-xs font-medium ${
                        section === 'groups' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      上位查询分组
                    </button>
                  </div>
                </div>
                {section === 'codes' ? (
                  <>
                    <div className="relative">
                      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-slate-400" />
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索代码、名称或同义读法"
                        aria-label="搜索代码或名称"
                        className="pl-8"
                      />
                    </div>
                    {canManage && (
                      <form onSubmit={(event) => void handleAdd(event)} className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={dmz}
                          onChange={(event) => setDmz(event.target.value)}
                          placeholder="代码"
                          aria-label="新代码"
                          className="font-mono-tabular sm:w-32"
                        />
                        <Input
                          value={label}
                          onChange={(event) => setLabel(event.target.value)}
                          placeholder="名称"
                          aria-label="新名称"
                          className="min-w-0 flex-1"
                        />
                        <Button type="submit" className="self-start px-3.5">
                          新增代码
                        </Button>
                      </form>
                    )}
                  </>
                ) : (
                  <>
                  <form onSubmit={(event) => void submitGroup(event)} className="flex flex-col gap-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={groupName}
                        onChange={(event) => setGroupName(event.target.value)}
                        placeholder="分组名称，例如摩托车"
                        aria-label="分组名称"
                        className="sm:w-48"
                        disabled={!canManage}
                      />
                      <Input
                        value={groupMembers}
                        onChange={(event) => setGroupMembers(event.target.value)}
                        placeholder="成员代码，至少两个，用逗号或空格分开"
                        aria-label="分组成员"
                        className="flex-1 font-mono-tabular"
                        disabled={!canManage}
                      />
                    {canManage && (
                      <Button type="submit" className="self-start px-3.5">
                        {editingGroup ? '保存' : '添加分组'}
                      </Button>
                    )}
                  </div>
                </form>
                <form onSubmit={(event) => void runExpand(event)} className="flex flex-col gap-2 sm:flex-row">
                      <Select
                        value={expandField}
                        onChange={(event) => setExpandField(event.target.value)}
                        aria-label="试查字段"
                        className="max-w-full"
                      >
                        {selectedGroup.fields.map((field) => (
                          <option key={field.code} value={field.code}>
                            {field.code} {field.name}
                          </option>
                        ))}
                      </Select>
                      <Input
                        value={expandTerm}
                        onChange={(event) => setExpandTerm(event.target.value)}
                        placeholder="试查一个说法"
                        aria-label="试查说法"
                        className="min-w-0 flex-1"
                      />
                      <Button type="submit" variant="outline" className="self-start px-3.5">
                        试查
                      </Button>
                    </form>
                    {expandText ? <p className="text-sm text-slate-700">{expandText}</p> : null}
                  </>
                )}
              </div>

              {section === 'codes' ? (
                <div ref={scrollRef} className="mt-3 min-h-0 overflow-auto max-md:max-h-[60vh]">
                  <Table>
                    <TableHeader>
                      <TableRow className="sticky top-0 z-10 bg-slate-50 hover:bg-slate-50">
                        <TableHead className="w-24 text-xs font-semibold text-slate-600">代码</TableHead>
                        <TableHead className="text-xs font-semibold text-slate-600">名称与同义读法</TableHead>
                        {canManage && <TableHead className="w-20 text-right">操作</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {codes.map((row) => (
                        <TableRow key={row.dmz}>
                          <TableCell className="font-mono-tabular text-xs text-slate-700">{row.dmz}</TableCell>
                          <TableCell className="whitespace-normal">
                            {canManage ? (
                              <LabelEditor
                                dmz={row.dmz}
                                label={row.label}
                                onRename={(code, next) => handleRename(selectedGroup.authority, code, next)}
                              />
                            ) : (
                              <span className="text-sm text-slate-800">{row.label}</span>
                            )}
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {(row.aliases ?? []).map((phrase) => (
                                <span
                                  key={phrase}
                                  className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-800"
                                >
                                  {phrase}
                                  {canManage && (
                                    <button
                                      type="button"
                                      className="text-slate-500 hover:text-slate-900"
                                      aria-label={`删除同义读法 ${phrase}`}
                                      onClick={() => setPendingAlias({ dmz: row.dmz, phrase })}
                                    >
                                      ×
                                    </button>
                                  )}
                                </span>
                              ))}
                              {canManage && aliasFor === row.dmz ? (
                                <form
                                  className="flex gap-1"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void submitAlias(row.dmz);
                                  }}
                                >
                                  <Input
                                    value={aliasPhrase}
                                    onChange={(event) => setAliasPhrase(event.target.value)}
                                    placeholder="同义读法"
                                    aria-label={`为 ${row.dmz} 添加同义读法`}
                                    className="h-7 w-28 text-xs"
                                  />
                                  <Button type="submit" className="h-7 px-2 text-xs">
                                    添加
                                  </Button>
                                </form>
                              ) : canManage ? (
                                <button
                                  type="button"
                                  className="text-xs font-medium text-blue-700 hover:text-blue-900"
                                  onClick={() => {
                                    setAliasFor(row.dmz);
                                    setAliasPhrase('');
                                  }}
                                >
                                  添加同义读法
                                </button>
                              ) : null}
                            </div>
                          </TableCell>
                          {canManage && (
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setPendingDelete(row)}
                                aria-label={`删除代码 ${row.dmz}`}
                              >
                                <Trash2 className="size-3.5" />
                                删除
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {loadingPage && codes.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-500">正在加载代码</div>
                  ) : codes.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-500">没有匹配的代码</div>
                  ) : null}
                  <div ref={sentinelRef} className="h-1" />
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-xs text-slate-500 tabular-nums">
                      已加载 {codes.length} / {total}
                    </span>
                    {loadingPage && codes.length > 0 ? <span className="text-xs text-slate-500">正在加载</span> : null}
                  </div>
                </div>
              ) : (
                <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {readings.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-500">这个代码表还没有上位查询分组</div>
                  ) : (
                    readings.map((group) => (
                      <div key={group.name} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 px-3 py-2.5">
                        <div>
                          <div className="text-sm font-medium text-slate-900">
                            {`${group.name} -> ${memberSpan(group.members)}`}
                          </div>
                          <p className="mt-1 font-mono-tabular text-xs text-slate-500">
                            {group.members.map((member) => `${member.dmz} ${member.label}`).join('，')}
                          </p>
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setEditingGroup(group.name);
                                setGroupName(group.name);
                                setGroupMembers(group.members.map((member) => member.dmz).join(' '));
                              }}
                            >
                              编辑
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setPendingGroup(group.name)}>
                              删除
                            </Button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">{ready ? '没有可维护的代码表' : '正在加载标签库'}</div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">未绑定代码表的字段</h2>
        <p className="mt-1 text-xs text-slate-500">这些槽位没有通行标准码。枚举字段仍可以添加本系统扩充标签。</p>
        <ul className="mt-3 divide-y divide-slate-100">
          {unbound.map((field) => (
            <li
              key={field.code}
              className="grid grid-cols-1 items-baseline gap-1 py-2 sm:grid-cols-[120px_160px_minmax(0,1fr)] sm:gap-3"
            >
              <span className="font-mono-tabular text-xs text-slate-500">{field.code}</span>
              <span className="text-sm font-medium text-slate-900">{field.name}</span>
              <span className="text-sm text-slate-600">{field.reason}</span>
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条代码</DialogTitle>
            <DialogDescription>
              {pendingDelete ? `代码 ${pendingDelete.dmz}，名称「${pendingDelete.label}」。` : ''}
              若同义读法或查询分组还引用它，删除会被拒绝。
            </DialogDescription>
          </DialogHeader>
          {selectedGroup?.legal ? (
            <p className="text-sm text-amber-800">这是法律结论代码。已经命中的记录仍要人工确认。</p>
          ) : null}
          {lastCode ? (
            <p className="text-sm text-slate-600">请为该类型保留至少一条代码。</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={lastCode || deleting} onClick={() => void confirmRemove()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingAlias !== null} onOpenChange={(open) => { if (!open) setPendingAlias(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除同义读法</DialogTitle>
            <DialogDescription>
              {pendingAlias ? `「${pendingAlias.phrase}」不再指向代码 ${pendingAlias.dmz}。标准代码本身保留。` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingAlias(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmRemoveAlias()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingGroup !== null} onOpenChange={(open) => { if (!open) setPendingGroup(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除查询分组</DialogTitle>
            <DialogDescription>
              {pendingGroup ? `分组「${pendingGroup}」删除后，这个说法不再展开成一组标准代码。` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingGroup(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmRemoveGroup()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function homeLabel(row: ObservationRow): string {
  const home = row.disposition;
  if (home.kind === 'standard') return `标准码 ${home.authority}/${home.dmz}`;
  if (home.kind === 'alias') return `已归入别名 ${home.dmz}`;
  if (home.kind === 'group') return `上位分组 ${home.groupName}`;
  if (home.kind === 'extension') return `扩充标签 ${home.extCode}`;
  if (home.kind === 'linked') return `已关联 ${home.authority}/${home.dmz}`;
  return '待处理';
}

function statusLabel(status: ReviewStatus, weight: number | null): string {
  if (status === 'confirmed') return `已确认 ${weight ?? ''}`;
  if (status === 'rejected') return '已标不准';
  return '待评估';
}

function ObservationsPanel({ userId, canManage }: CodebookViewProps) {
  const [report, setReport] = useState<ObservationReport | null>(null);
  const [field, setField] = useState('all');
  const [status, setStatus] = useState<'all' | ReviewStatus>('all');
  const [query, setQuery] = useState('');
  const [weightRow, setWeightRow] = useState<ObservationRow | null>(null);
  const [weight, setWeight] = useState('1.0');
  const [promote, setPromote] = useState<{ row: ObservationRow; mode: 'alias' | 'extension' | 'link' } | null>(null);
  const [dmz, setDmz] = useState('');
  const [extLabel, setExtLabel] = useState('');
  const [extCode, setExtCode] = useState('');
  const [fieldTags, setFieldTags] = useState<ExtensionTag[]>([]);

  const load = useCallback(() => {
    api
      .getObservations(userId)
      .then(setReport)
      .catch((err) => toast.error(errorText(err, '加载表外观察失败')));
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.rows ?? []).filter((row) => {
      if (field !== 'all' && row.fieldCode !== field) return false;
      if (status !== 'all' && row.status !== status) return false;
      if (!needle) return true;
      return [row.rawText, row.textKey, row.fieldName, row.fieldCode].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [report, field, status, query]);

  const fields = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of report?.rows ?? []) seen.set(row.fieldCode, row.fieldName);
    return [...seen.entries()];
  }, [report]);

  const stats = report?.stats;
  const reviewed = (stats?.confirmed ?? 0) + (stats?.rejected ?? 0);

  const submitWeight = async () => {
    if (!weightRow) return;
    try {
      await api.reviewObservation(userId, {
        fieldCode: weightRow.fieldCode,
        textKey: weightRow.textKey,
        status: 'confirmed',
        weight: Number(weight),
      });
      setWeightRow(null);
      load();
      toast.success('已确认并记录权重');
    } catch (err) {
      toast.error(errorText(err, '确认失败'));
    }
  };

  const rejectRow = async (row: ObservationRow) => {
    try {
      await api.reviewObservation(userId, { fieldCode: row.fieldCode, textKey: row.textKey, status: 'rejected' });
      load();
      toast.success('已标为不准');
    } catch (err) {
      toast.error(errorText(err, '标记失败'));
    }
  };

  const openPromote = (row: ObservationRow, mode: 'alias' | 'extension' | 'link') => {
    setPromote({ row, mode });
    setDmz('');
    setExtLabel(row.rawText);
    setExtCode('');
    if (mode === 'extension') {
      api
        .getExtensionTags(userId, row.fieldCode)
        .then((book) => setFieldTags(book.tags))
        .catch((err) => toast.error(errorText(err, '加载扩充标签失败')));
    }
  };

  const submitPromote = async () => {
    if (!promote) return;
    const target =
      promote.mode === 'alias'
        ? { kind: 'alias' as const, dmz }
        : promote.mode === 'link'
          ? { kind: 'link_standard' as const, dmz }
          : extCode
            ? { kind: 'existing_extension' as const, extCode }
            : { kind: 'new_extension' as const, label: extLabel };
    try {
      await api.promoteObservation(userId, {
        fieldCode: promote.row.fieldCode,
        textKey: promote.row.textKey,
        target,
      });
      setPromote(null);
      load();
      toast.success('已归入标签库');
    } catch (err) {
      toast.error(errorText(err, '归入失败'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-5">
        {[
          ['待评估', String(stats?.pending ?? 0)],
          ['已确认准确', String(stats?.confirmed ?? 0)],
          ['已标不准', String(stats?.rejected ?? 0)],
          ['词条准确率', percent(stats?.termAccuracy ?? 0, reviewed > 0)],
          ['事故加权准确率', percent(stats?.weightedAccuracy ?? 0, reviewed > 0)],
        ].map(([name, value]) => (
          <div key={name} className="px-4 py-3.5 even:bg-slate-50/50 sm:border-r sm:border-slate-100 sm:last:border-r-0">
            <div className="text-xs font-medium text-slate-500">{name}</div>
            <div className="font-mono-tabular mt-1 text-2xl font-semibold text-slate-900">{value}</div>
          </div>
        ))}
      </div>
      <section aria-label="表外观察列表" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <Select
          value={field}
          onChange={(event) => setField(event.target.value)}
          aria-label="按字段筛选"
          className="max-w-full"
        >
          <option value="all">全部字段</option>
          {fields.map(([code, name]) => (
            <option key={code} value={code}>
              {code} {name}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value as 'all' | ReviewStatus)}
          aria-label="按状态筛选"
          className="max-w-full"
        >
          <option value="all">全部状态</option>
          <option value="pending">待评估</option>
          <option value="confirmed">已确认准确</option>
          <option value="rejected">已标不准</option>
        </Select>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索表外原文"
          aria-label="搜索表外原文"
          className="min-w-40 flex-1 sm:max-w-sm"
        />
      </div>
      <div className="max-h-[max(24rem,calc(100vh-18rem))] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="sticky top-0 z-10 bg-slate-50 hover:bg-slate-50">
              <TableHead className="text-xs font-semibold text-slate-600">字段</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">表外原文</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">涉及事故数</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">确认状态与权重</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">当前归宿</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">原文依据样例</TableHead>
              <TableHead className="text-xs font-semibold text-slate-600">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.fieldCode}-${row.textKey}`}>
                <TableCell className="whitespace-normal text-xs">
                  <div className="font-mono-tabular text-slate-500">{row.fieldCode}</div>
                  <div className="text-slate-800">{row.fieldName}</div>
                </TableCell>
                <TableCell className="whitespace-normal text-sm text-slate-900">{row.rawText}</TableCell>
                <TableCell className="text-sm text-slate-800 tabular-nums">{row.accidentCount}</TableCell>
                <TableCell className="whitespace-normal text-xs text-slate-700">
                  <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-medium ${row.status === 'confirmed' ? 'bg-emerald-50 text-emerald-800' : row.status === 'rejected' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}>{statusLabel(row.status, row.weight)}</span>
                </TableCell>
                <TableCell className="whitespace-normal text-xs text-slate-700">{homeLabel(row)}</TableCell>
                <TableCell className="max-w-[220px] whitespace-normal text-xs text-slate-600">
                  {row.samples[0]?.quote || '无'}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {canManage ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setWeightRow(row);
                          setWeight('1.0');
                        }}
                      >
                        确认准确并赋权重
                      </Button>
                      <Button type="button" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void rejectRow(row)}>
                        标记不准
                      </Button>
                      {row.status === 'confirmed' && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={!row.authority}
                            onClick={() => openPromote(row, 'alias')}
                          >
                            归入同义读法
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => openPromote(row, 'extension')}
                          >
                            升为扩充标签
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={!row.authority}
                            onClick={() => openPromote(row, 'link')}
                          >
                            关联标准码
                          </Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">只读</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length === 0 ? <div className="py-8 text-center text-sm text-slate-500">没有匹配的表外观察</div> : null}
      </div>

      </section>

      <Dialog open={weightRow !== null} onOpenChange={(open) => { if (!open) setWeightRow(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认准确并赋权重</DialogTitle>
            <DialogDescription>
              {weightRow ? `「${weightRow.rawText}」记为准确。权重默认 1.0，只用于事故加权准确率，不会写入通行标准码表。` : ''}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            type="number"
            min="0.1"
            step="0.1"
            aria-label="权重"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setWeightRow(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void submitWeight()}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={promote !== null} onOpenChange={(open) => { if (!open) setPromote(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {promote?.mode === 'alias' ? '归入同义读法' : promote?.mode === 'link' ? '关联标准码' : '升为扩充标签'}
            </DialogTitle>
            <DialogDescription>
              {promote ? `「${promote.row.rawText}」归入后，标准代码表里的 dmz 不会被改写。` : ''}
            </DialogDescription>
          </DialogHeader>
          {promote?.mode === 'extension' ? (
            <div className="space-y-2">
              <Input value={extLabel} onChange={(event) => setExtLabel(event.target.value)} aria-label="扩充标签名称" placeholder="新扩充标签名称" />
              <Select
                value={extCode}
                onChange={(event) => setExtCode(event.target.value)}
                aria-label="已有扩充标签"
                className="w-full"
              >
                <option value="">新建 ext 标签</option>
                {fieldTags.map((tag) => (
                  <option key={tag.extCode} value={tag.extCode}>
                    {tag.extCode} {tag.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <Input value={dmz} onChange={(event) => setDmz(event.target.value)} aria-label="目标代码" placeholder="目标 dmz" className="font-mono" />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPromote(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void submitPromote()}>
              归入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExtensionsPanel({ userId, canManage }: CodebookViewProps) {
  const [fields, setFields] = useState<Array<{ code: string; name: string }>>([]);
  const [tags, setTags] = useState<ExtensionTag[]>([]);
  const [field, setField] = useState('all');
  const [fieldCode, setFieldCode] = useState('');
  const [label, setLabel] = useState('');
  const [aliases, setAliases] = useState('');
  const [pending, setPending] = useState<ExtensionTag | null>(null);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const [aliasText, setAliasText] = useState('');

  const load = useCallback(() => {
    api
      .getExtensionTags(userId)
      .then((book) => {
        setFields(book.fields);
        setTags(book.tags);
        setFieldCode((current) => current || book.fields[0]?.code || '');
      })
      .catch((err) => toast.error(errorText(err, '加载扩充标签失败')));
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = tags.filter((tag) => field === 'all' || tag.fieldCode === field);

  const createTag = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.createExtensionTag(userId, fieldCode, label, splitCodes(aliases));
      setLabel('');
      setAliases('');
      load();
      toast.success('已添加扩充标签');
    } catch (err) {
      toast.error(errorText(err, '添加扩充标签失败'));
    }
  };

  const saveLabel = async (tag: ExtensionTag, next: string) => {
    if (next.trim() === tag.label) return;
    try {
      await api.updateExtensionTag(userId, tag.extCode, { label: next });
      load();
    } catch (err) {
      toast.error(errorText(err, '更新名称失败'));
    }
  };

  const addAlias = async (tag: ExtensionTag) => {
    if (!aliasText.trim()) return;
    try {
      await api.updateExtensionTag(userId, tag.extCode, { aliases: [...tag.aliases, aliasText.trim()] });
      setAliasDraft(null);
      setAliasText('');
      load();
    } catch (err) {
      toast.error(errorText(err, '添加读法失败'));
    }
  };

  const confirmRemove = async () => {
    if (!pending) return;
    try {
      await api.removeExtensionTag(userId, pending.extCode);
      setPending(null);
      load();
      toast.success('已删除扩充标签');
    } catch (err) {
      toast.error(errorText(err, '删除扩充标签失败'));
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-semibold text-slate-900">
            <Tags className="h-4 w-4 text-blue-700" aria-hidden="true" />新增扩充标签
          </h2>
          <p className="mt-3 text-xs text-slate-500">扩充标签仅用于本系统的风险分析，适用于法律结论以外的枚举字段。</p>
          <form onSubmit={(event) => void createTag(event)} className="mt-3 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <label className="grid gap-1.5 text-xs font-medium text-slate-700">
              所属字段
              <Select value={fieldCode} onChange={(event) => setFieldCode(event.target.value)}>
                {fields.map((item) => <option key={item.code} value={item.code}>{item.code} {item.name}</option>)}
              </Select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-slate-700">
              标签名称
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-slate-700">
              同义读法（选填）
              <Input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="多个读法用逗号或空格分隔" />
            </label>
            <Button type="submit" className="justify-self-start">添加标签</Button>
          </form>
        </section>
      )}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <ListTree className="h-4 w-4 text-blue-700" aria-hidden="true" />已维护的扩充标签
          </h2>
          <Select value={field} onChange={(event) => setField(event.target.value)} aria-label="按字段筛选扩充标签" className="max-w-full">
            <option value="all">全部枚举字段</option>
            {fields.map((item) => <option key={item.code} value={item.code}>{item.code} {item.name}</option>)}
          </Select>
        </div>
        {visible.length === 0 && (
          <p className="py-10 text-center text-xs text-slate-500">{field === 'all' ? '还没有扩充标签' : '当前字段没有扩充标签'}</p>
        )}
        {visible.map((tag) => (
          <div key={tag.extCode} className="border-b border-slate-100 py-3 last:border-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-mono-tabular text-xs text-blue-900">{tag.extCode}</div>
                <div className="text-xs text-slate-500">
                  {tag.fieldCode} {tag.fieldName}
                </div>
              </div>
              {canManage && (
                <Button type="button" variant="ghost" onClick={() => setPending(tag)}>
                  删除
                </Button>
              )}
            </div>
            {canManage ? (
              <Input
                defaultValue={tag.label}
                key={`${tag.extCode}-${tag.label}`}
                aria-label={`修改 ${tag.extCode} 的名称`}
                className="mt-2 max-w-lg"
                onBlur={(event) => void saveLabel(tag, event.target.value)}
              />
            ) : (
              <div className="mt-2 text-sm text-slate-900">{tag.label}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {tag.aliases.map((phrase) => (
                <span key={phrase} className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-900">
                  {phrase}
                </span>
              ))}
              {canManage && aliasDraft === tag.extCode ? (
                <form
                  className="flex gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addAlias(tag);
                  }}
                >
                  <Input
                    value={aliasText}
                    onChange={(event) => setAliasText(event.target.value)}
                    aria-label={`为 ${tag.extCode} 添加读法`}
                    className="h-7 w-36 text-xs"
                  />
                  <Button type="submit" className="h-7 px-2 text-xs">
                    添加
                  </Button>
                </form>
              ) : canManage ? (
                <button
                  type="button"
                  className="text-xs font-medium text-blue-700 hover:text-blue-900"
                  onClick={() => {
                    setAliasDraft(tag.extCode);
                    setAliasText('');
                  }}
                >
                  添加读法
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除扩充标签</DialogTitle>
            <DialogDescription>
              {pending ? `${pending.extCode}「${pending.label}」删除后不再参与归一。平台标准代码不受影响，编号也不会回收。` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmRemove()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LabelEditor({
  dmz,
  label,
  onRename,
}: {
  dmz: string;
  label: string;
  onRename: (dmz: string, label: string) => Promise<void>;
}) {
  const [value, setValue] = useState(label);

  useEffect(() => {
    setValue(label);
  }, [label]);

  return (
    <Input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value.trim() === label) {
          setValue(label);
          return;
        }
        void onRename(dmz, value).catch(() => setValue(label));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      aria-label={`修改 ${dmz} 的名称`}
      className="max-w-lg"
    />
  );
}
