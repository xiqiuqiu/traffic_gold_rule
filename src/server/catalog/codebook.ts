import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTER_FIELD_SCHEMA } from '../../data/schemaCatalog';
import type { CatalogOptions, ObservationDisposition } from '../../types/catalog';
import { JsonMap, type JsonValue, parseOrderedJson, stableJson, writeAtomic } from './orderedJson';
import { textKey } from './textKey';

const seedDir = fileURLToPath(new URL('../../data/catalog/', import.meta.url));
export const catalogDir = path.resolve(process.env.SYSTEM_DATA_DIR || '.local-data', 'catalog');
export const CODEBOOK_FILE = path.join(catalogDir, 'business_codes.v1.json');
export const TAG_LIBRARY_FILE = path.join(catalogDir, 'tag_library.v1.json');
export const BINDINGS_FILE = path.join(seedDir, 'code_bindings.v1.json');
const catalogFields = MASTER_FIELD_SCHEMA.map(field => ({
  code: field.fieldCode, name: field.fieldName, type: field.valueType,
}));

export interface CodeGroup {
  authority: string;
  legal: boolean;
  fields: { code: string; name: string }[];
  count: number;
}

export interface UnboundField {
  code: string;
  name: string;
  reason: string;
}

export interface CodeRow {
  dmz: string;
  label: string;
  aliases?: string[];
}

export interface AliasRow {
  phrase: string;
  dmz: string;
  label: string;
}

export interface ReadingGroup {
  name: string;
  authority: string;
  members: { dmz: string; label: string }[];
}

export interface QueryExpansion {
  fieldCode: string;
  authority: string | null;
  dmz: string[];
  extension: string | null;
  via: 'dmz' | 'label' | 'alias' | 'group' | 'extension' | 'none';
}

export interface ExtensionTagRow {
  extCode: string;
  fieldCode: string;
  fieldName: string;
  label: string;
  aliases: string[];
}

export interface EnumFieldChoice {
  code: string;
  name: string;
}

export interface ExtensionPatch {
  label?: string;
  aliases?: string[];
}

export class CodebookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodebookError';
  }
}

interface BindingRow {
  authority?: unknown;
  reason?: unknown;
  legal_conclusion?: unknown;
}

interface PhraseHit {
  kind: 'dmz' | 'label' | 'alias' | 'group' | 'extension';
  name: string;
}

const DMZ_MAX = 32;
const LABEL_MAX = 80;
const LEGAL_FIELDS = new Set(['D10.F058', 'D10.F059', 'D10.F060']);
const EXT_CODE = /^ext:\d{4,}$/;

export function listGroups(
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
): { groups: CodeGroup[]; unbound: UnboundField[] } {
  const authorities = authorityMap(readCodebook(codeFile));
  const bindings = readBindings(bindingFile);
  const groups = new Map<string, CodeGroup>();
  const unbound: UnboundField[] = [];

  for (const field of catalogFields) {
    const binding = bindings.get(field.code);
    if (!binding) continue;
    const authority = stringAuthority(binding.authority);
    if (!authority) {
      unbound.push({
        code: field.code,
        name: field.name,
        reason: typeof binding.reason === 'string' ? binding.reason : '',
      });
      continue;
    }
    const codes = codesInFile(authorities, authority);
    if (!codes) continue;
    let group = groups.get(authority);
    if (!group) {
      group = { authority, legal: false, fields: [], count: codes.size };
      groups.set(authority, group);
    }
    group.fields.push({ code: field.code, name: field.name });
    if (binding.legal_conclusion === true) group.legal = true;
  }

  return { groups: [...groups.values()], unbound };
}

export function listCodes(
  authority: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): CodeRow[] {
  const codes = editableCodes(readCodebook(codeFile), readBindings(bindingFile), authority);
  const aliases = aliasesFor(readTag(resolveTagFile(codeFile, tagFile)), authority.trim());
  return rowsOf(codes).map((row) => ({ ...row, aliases: aliases.get(row.dmz) ?? [] }));
}

export const CODE_PAGE_SIZE = 40;

export interface CodePage {
  total: number;
  offset: number;
  limit: number;
  codes: CodeRow[];
}

export function pageCodes(
  authority: string,
  query = '',
  offset = 0,
  limit = CODE_PAGE_SIZE,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): CodePage {
  const rows = listCodes(authority, codeFile, bindingFile, tagFile);
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? rows.filter(
        (row) =>
          row.dmz.toLowerCase().includes(needle) ||
          row.label.toLowerCase().includes(needle) ||
          (row.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle)),
      )
    : rows;
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const size = Math.min(80, Math.max(1, Math.floor(limit) || CODE_PAGE_SIZE));
  return {
    total: matched.length,
    offset: start,
    limit: size,
    codes: matched.slice(start, start + size),
  };
}

export function addCode(
  authority: string,
  dmz: string,
  label: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): CodeRow {
  const cleaned = cleanPair(dmz, label);
  const root = readCodebook(codeFile);
  const bindings = readBindings(bindingFile);
  const codes = editableCodes(root, bindings, authority);
  if (codes.has(cleaned.dmz)) {
    throw new CodebookError(`代码 ${cleaned.dmz} 已存在`);
  }
  const other = otherDmz(codes, cleaned.label);
  if (other) throw duplicateLabel(cleaned.label, other);
  const tag = readTag(resolveTagFile(codeFile, tagFile));
  const hit = phraseHits(textKey(cleaned.label), codes, tag, authority.trim(), bindings, {
    dmz: cleaned.dmz,
  });
  if (hit) throw collisionError(cleaned.label, hit);
  codes.set(cleaned.dmz, cleaned.label);
  writeCodebook(codeFile, root);
  return { ...cleaned, aliases: [] };
}

export function renameCode(
  authority: string,
  dmz: string,
  label: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): CodeRow {
  const code = requireDmz(dmz);
  const name = requireLabel(label);
  const root = readCodebook(codeFile);
  const bindings = readBindings(bindingFile);
  const codes = editableCodes(root, bindings, authority);
  const current = codes.get(code);
  if (typeof current !== 'string') {
    throw new CodebookError(`代码 ${code} 不存在`);
  }
  if (name !== current) {
    const other = otherDmz(codes, name);
    if (other) throw duplicateLabel(name, other);
    const tag = readTag(resolveTagFile(codeFile, tagFile));
    const hit = phraseHits(textKey(name), codes, tag, authority.trim(), bindings, { dmz: code });
    if (hit) throw collisionError(name, hit);
    codes.set(code, name);
    writeCodebook(codeFile, root);
  }
  const aliases = aliasesFor(readTag(resolveTagFile(codeFile, tagFile)), authority.trim());
  return { dmz: code, label: name, aliases: aliases.get(code) ?? [] };
}

export function removeCode(
  authority: string,
  dmz: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): CodeRow {
  const code = requireDmz(dmz);
  const root = readCodebook(codeFile);
  const codes = editableCodes(root, readBindings(bindingFile), authority);
  const current = codes.get(code);
  if (typeof current !== 'string') {
    throw new CodebookError(`代码 ${code} 不存在`);
  }
  const refs = referencesTo(readTag(resolveTagFile(codeFile, tagFile)), authority.trim(), code);
  if (refs.length > 0) {
    throw new CodebookError(`代码 ${code} 被${refs.join('、')}引用，不能删除`);
  }
  if (codes.size === 1) {
    throw new CodebookError('不能删除这个类型的最后一条代码。');
  }
  codes.delete(code);
  writeCodebook(codeFile, root);
  return { dmz: code, label: current };
}

export function listReadings(
  authority: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): { aliases: AliasRow[]; groups: ReadingGroup[] } {
  const key = authority.trim();
  const codes = editableCodes(readCodebook(codeFile), readBindings(bindingFile), key);
  const tag = readTag(resolveTagFile(codeFile, tagFile));
  const aliases: AliasRow[] = [];
  const aliasMap = lookupMap(tag, 'aliases', key);
  if (aliasMap) {
    for (const [phrase, dmz] of aliasMap) {
      if (typeof dmz !== 'string') continue;
      const label = codes.get(dmz);
      aliases.push({ phrase, dmz, label: typeof label === 'string' ? label : '' });
    }
  }
  const groups: ReadingGroup[] = [];
  const groupMap = lookupMap(tag, 'query_groups', key);
  if (groupMap) {
    for (const [name, members] of groupMap) {
      groups.push({
        name,
        authority: key,
        members: stringList(members).map((dmz) => {
          const label = codes.get(dmz);
          return { dmz, label: typeof label === 'string' ? label : '' };
        }),
      });
    }
  }
  return { aliases, groups };
}

export function addAlias(
  authority: string,
  phrase: string,
  dmz: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): AliasRow {
  const key = authority.trim();
  const cleaned = requirePhrase(phrase, '同义读法');
  const code = requireDmz(dmz);
  const bindings = readBindings(bindingFile);
  const codes = editableCodes(readCodebook(codeFile), bindings, key);
  const label = codes.get(code);
  if (typeof label !== 'string') throw new CodebookError(`代码 ${code} 不存在`);
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const bucket = objectChild(objectChild(tag, 'aliases'), key);
  for (const [existing, target] of bucket) {
    if (textKey(existing) === textKey(cleaned) && target === code) {
      return { phrase: existing, dmz: code, label };
    }
  }
  const hit = phraseHits(textKey(cleaned), codes, tag, key, bindings, {});
  if (hit) throw collisionError(cleaned, hit);
  bucket.set(cleaned, code);
  writeTag(tagPath, tag);
  return { phrase: cleaned, dmz: code, label };
}

export function removeAlias(
  authority: string,
  phrase: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): AliasRow {
  const key = authority.trim();
  const codes = editableCodes(readCodebook(codeFile), readBindings(bindingFile), key);
  const wanted = textKey(phrase);
  if (!wanted) throw new CodebookError('同义读法不能为空');
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const bucket = lookupMap(tag, 'aliases', key);
  if (!bucket) throw new CodebookError(`同义读法「${phrase.trim()}」不存在`);
  for (const [existing, dmz] of bucket) {
    if (textKey(existing) !== wanted || typeof dmz !== 'string') continue;
    bucket.delete(existing);
    writeTag(tagPath, tag);
    const label = codes.get(dmz);
    return { phrase: existing, dmz, label: typeof label === 'string' ? label : '' };
  }
  throw new CodebookError(`同义读法「${phrase.trim()}」不存在`);
}

export function putQueryGroup(
  authority: string,
  name: string,
  members: string[],
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): ReadingGroup {
  const key = authority.trim();
  const cleaned = name.normalize('NFKC').trim();
  if (!textKey(cleaned)) throw new CodebookError('查询分组名称不能为空');
  const bindings = readBindings(bindingFile);
  const codes = editableCodes(readCodebook(codeFile), bindings, key);
  const distinct: string[] = [];
  for (const member of members) {
    const code = requireDmz(member);
    if (typeof codes.get(code) !== 'string') throw new CodebookError(`代码 ${code} 不存在`);
    if (!distinct.includes(code)) distinct.push(code);
  }
  if (distinct.length < 2) throw new CodebookError('查询分组至少包含两个不同的代码');
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const bucket = objectChild(objectChild(tag, 'query_groups'), key);
  let storedName = cleaned;
  for (const existing of bucket.keys()) {
    if (textKey(existing) === textKey(cleaned)) storedName = existing;
  }
  const hit = phraseHits(textKey(cleaned), codes, tag, key, bindings, { groupKey: storedName });
  if (hit) throw collisionError(cleaned, hit);
  if (storedName !== cleaned && bucket.has(storedName)) bucket.delete(storedName);
  bucket.set(cleaned, distinct);
  writeTag(tagPath, tag);
  return {
    name: cleaned,
    authority: key,
    members: distinct.map((dmz) => ({ dmz, label: String(codes.get(dmz)) })),
  };
}

export function removeQueryGroup(
  authority: string,
  name: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): ReadingGroup {
  const key = authority.trim();
  const codes = editableCodes(readCodebook(codeFile), readBindings(bindingFile), key);
  const wanted = textKey(name);
  if (!wanted) throw new CodebookError('查询分组名称不能为空');
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const bucket = lookupMap(tag, 'query_groups', key);
  if (!bucket) throw new CodebookError(`查询分组「${name.trim()}」不存在`);
  for (const [existing, members] of bucket) {
    if (textKey(existing) !== wanted) continue;
    const list = stringList(members);
    bucket.delete(existing);
    writeTag(tagPath, tag);
    return {
      name: existing,
      authority: key,
      members: list.map((dmz) => {
        const label = codes.get(dmz);
        return { dmz, label: typeof label === 'string' ? label : '' };
      }),
    };
  }
  throw new CodebookError(`查询分组「${name.trim()}」不存在`);
}

export function expandQuery(
  fieldCode: string,
  term: string,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): QueryExpansion {
  const field = fieldCode.trim();
  const authority = fieldAuthority(field, bindingFile);
  const tag = readTag(resolveTagFile(codeFile, tagFile));
  const cleaned = term.normalize('NFKC').trim();
  const key = textKey(term);
  const pack = (
    via: QueryExpansion['via'],
    dmz: string[],
    extension: string | null,
  ): QueryExpansion => ({ fieldCode: field, authority, dmz, extension, via });

  if (authority) {
    const codes = codesInFile(authorityMap(readCodebook(codeFile)), authority);
    if (codes) {
      if (cleaned && codes.has(cleaned)) return pack('dmz', [cleaned], null);
      if (key) {
        const labelHits: string[] = [];
        for (const [dmz, label] of codes) {
          if (typeof label === 'string' && textKey(label) === key) labelHits.push(dmz);
        }
        if (labelHits.length > 0) return pack('label', labelHits, null);
        const aliases = lookupMap(tag, 'aliases', authority);
        if (aliases) {
          for (const [phrase, dmz] of aliases) {
            if (typeof dmz === 'string' && textKey(phrase) === key && codes.has(dmz)) {
              return pack('alias', [dmz], null);
            }
          }
        }
        const groups = lookupMap(tag, 'query_groups', authority);
        if (groups) {
          for (const [groupName, members] of groups) {
            if (textKey(groupName) !== key) continue;
            return pack(
              'group',
              stringList(members).filter((dmz) => codes.has(dmz)),
              null,
            );
          }
        }
      }
    }
  }

  if (key) {
    const tags = lookupMap(tag, 'extension_tags', field);
    if (tags) {
      for (const [ext, body] of tags) {
        if (!(body instanceof JsonMap) || !EXT_CODE.test(ext)) continue;
        const label = body.get('label');
        const names = [
          typeof label === 'string' ? label : '',
          ...stringList(body.get('aliases')),
        ];
        if (names.some((item) => textKey(item) === key)) return pack('extension', [], ext);
      }
    }
  }
  return pack('none', [], null);
}

export function listExtensionTags(
  fieldCode?: string,
  codeFile = CODEBOOK_FILE,
  tagFile?: string,
): ExtensionTagRow[] {
  const tag = readTag(resolveTagFile(codeFile, tagFile));
  const names = new Map(catalogFields.map(field => [field.code, field.name]));
  const wanted = fieldCode?.trim();
  const rows: ExtensionTagRow[] = [];
  const tags = lookupMap(tag, 'extension_tags');
  if (!tags) return rows;
  for (const [field, bucket] of tags) {
    if (wanted && field !== wanted) continue;
    if (!(bucket instanceof JsonMap)) continue;
    for (const [extCode, body] of bucket) {
      if (!(body instanceof JsonMap)) continue;
      const label = body.get('label');
      rows.push({
        extCode,
        fieldCode: field,
        fieldName: names.get(field) ?? field,
        label: typeof label === 'string' ? label : '',
        aliases: stringList(body.get('aliases')),
      });
    }
  }
  return rows;
}

export function listEnumFields(): EnumFieldChoice[] {
  return catalogFields
    .filter((field) => field.type.includes('枚举') && !LEGAL_FIELDS.has(field.code))
    .map((field) => ({ code: field.code, name: field.name }));
}

export function createExtensionTag(
  fieldCode: string,
  label: string,
  aliases: string[] = [],
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): ExtensionTagRow {
  const field = requireEnumField(fieldCode);
  const cleaned = requireLabel(label);
  const aliasList = cleanAliasList(aliases, cleaned);
  const bindings = readBindings(bindingFile);
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  assertExtensionKeys(field, cleaned, aliasList, tag, bindings, codeFile);
  const extCode = allocateExt(tag);
  const body = new JsonMap();
  body.set('label', cleaned);
  body.set('aliases', aliasList);
  objectChild(objectChild(tag, 'extension_tags'), field.code).set(extCode, body);
  writeTag(tagPath, tag);
  return { extCode, fieldCode: field.code, fieldName: field.name, label: cleaned, aliases: aliasList };
}

export function updateExtensionTag(
  extCode: string,
  patch: ExtensionPatch,
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
): ExtensionTagRow {
  const code = requireExtCode(extCode);
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const found = findExtension(tag, code);
  if (!found) throw new CodebookError(`扩充标签 ${code} 不存在`);
  const field = requireEnumField(found.fieldCode);
  const nextLabel = patch.label === undefined ? found.label : requireLabel(patch.label);
  const nextAliases = patch.aliases === undefined ? found.aliases : cleanAliasList(patch.aliases, nextLabel);
  const bindings = readBindings(bindingFile);
  assertExtensionKeys(field, nextLabel, nextAliases, tag, bindings, codeFile, code);
  found.body.set('label', nextLabel);
  found.body.set('aliases', nextAliases);
  writeTag(tagPath, tag);
  return {
    extCode: code,
    fieldCode: field.code,
    fieldName: field.name,
    label: nextLabel,
    aliases: nextAliases,
  };
}

export function removeExtensionTag(
  extCode: string,
  codeFile = CODEBOOK_FILE,
  tagFile?: string,
): ExtensionTagRow {
  const code = requireExtCode(extCode);
  const tagPath = resolveTagFile(codeFile, tagFile);
  const tag = readTag(tagPath);
  const found = findExtension(tag, code);
  if (!found) throw new CodebookError(`扩充标签 ${code} 不存在`);
  found.bucket.delete(code);
  writeTag(tagPath, tag);
  const names = new Map(catalogFields.map(field => [field.code, field.name]));
  return {
    extCode: code,
    fieldCode: found.fieldCode,
    fieldName: names.get(found.fieldCode) ?? found.fieldCode,
    label: found.label,
    aliases: found.aliases,
  };
}

export function fieldAuthority(fieldCode: string, bindingFile = BINDINGS_FILE): string | null {
  const binding = readBindings(bindingFile).get(fieldCode.trim());
  return binding ? stringAuthority(binding.authority) : null;
}

export function readPhraseClassifier(
  codeFile = CODEBOOK_FILE,
  bindingFile = BINDINGS_FILE,
  tagFile?: string,
) {
  const bindings = readBindings(bindingFile);
  const tables = authorityMap(readCodebook(codeFile));
  const tag = readTag(resolveTagFile(codeFile, tagFile));
  const authorityFor = (field: string) => stringAuthority(bindings.get(field)?.authority);
  function classify(field: string, key: string, linkedDmz: string | null = null): ObservationDisposition {
    const authority = authorityFor(field);
    const codes = authority ? codesInFile(tables, authority) : undefined;
    if (authority && codes && key) {
      for (const [dmz, label] of codes) {
        if (typeof label === 'string' && (textKey(dmz) === key || textKey(label) === key)) {
          return { kind: 'standard', authority, dmz, dmsm: label };
        }
      }
      const aliases = lookupMap(tag, 'aliases', authority);
      if (aliases) {
        for (const [phrase, dmz] of aliases) {
          if (typeof dmz !== 'string' || textKey(phrase) !== key) continue;
          const label = codes.get(dmz);
          if (typeof label !== 'string') continue;
          return { kind: 'alias', authority, dmz, dmsm: label };
        }
      }
      const groups = lookupMap(tag, 'query_groups', authority);
      if (groups) {
        for (const [groupName, members] of groups) {
          if (textKey(groupName) === key) {
            return { kind: 'group', authority, groupName, members: stringList(members) };
          }
        }
      }
    }
    const extensions = lookupMap(tag, 'extension_tags', field);
    if (extensions && key) {
      for (const [extCode, body] of extensions) {
        if (!(body instanceof JsonMap)) continue;
        const label = typeof body.get('label') === 'string' ? String(body.get('label')) : '';
        const aliases = stringList(body.get('aliases'));
        if (textKey(label) === key || aliases.some((alias) => textKey(alias) === key)) {
          return { kind: 'extension', extCode, label };
        }
      }
    }
    if (authority && codes && linkedDmz && typeof codes.get(linkedDmz) === 'string') {
      return { kind: 'linked', authority, dmz: linkedDmz, dmsm: String(codes.get(linkedDmz)) };
    }
    return { kind: 'open' };
  }
  return { classify, authorityFor };

}

function resolveTagFile(codeFile: string, tagFile?: string): string {
  if (typeof tagFile === 'string') return tagFile;
  if (codeFile === CODEBOOK_FILE) return TAG_LIBRARY_FILE;
  return path.join(path.dirname(codeFile), 'tag_library.v1.json');
}

function cleanPair(dmz: string, label: string): CodeRow {
  return { dmz: requireDmz(dmz), label: requireLabel(label) };
}

function requireDmz(dmz: string): string {
  const code = dmz.trim();
  if (!code) throw new CodebookError('代码不能为空');
  if (code.length > DMZ_MAX) throw new CodebookError('代码不能超过 32 个字符');
  return code;
}

function requireLabel(label: string): string {
  const name = label.trim();
  if (!name) throw new CodebookError('名称不能为空');
  if (name.length > LABEL_MAX) throw new CodebookError('名称不能超过 80 个字符');
  return name;
}

function requirePhrase(phrase: string, what: string): string {
  const cleaned = phrase.normalize('NFKC').trim();
  const key = textKey(cleaned);
  if (!key) throw new CodebookError(`${what}不能为空`);
  if (/^\d+$/.test(key)) throw new CodebookError(`${what}不能是纯数字`);
  return cleaned;
}

function requireExtCode(extCode: string): string {
  const code = extCode.trim();
  if (!EXT_CODE.test(code)) throw new CodebookError(`扩充标签编号 ${code || '空'} 无效`);
  return code;
}

function duplicateLabel(label: string, other: string): CodebookError {
  return new CodebookError(
    `名称「${label}」已被代码 ${other} 使用。同名会让分析无法选定代码。`,
  );
}

function collisionError(phrase: string, hit: PhraseHit): CodebookError {
  const where =
    hit.kind === 'dmz'
      ? `代码 ${hit.name}`
      : hit.kind === 'label'
        ? `名称「${hit.name}」`
        : hit.kind === 'alias'
          ? `同义读法「${hit.name}」`
          : hit.kind === 'group'
            ? `查询分组「${hit.name}」`
            : `扩充标签「${hit.name}」`;
  return new CodebookError(`「${phrase}」与${where}冲突`);
}

function otherDmz(codes: JsonMap, label: string): string | undefined {
  for (const [dmz, name] of codes) {
    if (name === label) return dmz;
  }
  return undefined;
}

function rowsOf(codes: JsonMap): CodeRow[] {
  const rows: CodeRow[] = [];
  for (const [dmz, label] of codes) {
    if (typeof label !== 'string') {
      throw new CodebookError(`代码 ${dmz} 的名称不是文本`);
    }
    rows.push({ dmz, label });
  }
  return rows;
}

function stringAuthority(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function referencedAuthorities(bindings: Map<string, BindingRow>): Set<string> {
  const names = new Set<string>();
  for (const binding of bindings.values()) {
    const authority = stringAuthority(binding.authority);
    if (authority) names.add(authority);
  }
  return names;
}

function editableCodes(root: JsonMap, bindings: Map<string, BindingRow>, authority: string): JsonMap {
  const key = authority.trim();
  const codes = key ? codesInFile(authorityMap(root), key) : undefined;
  if (!key || !referencedAuthorities(bindings).has(key) || !codes) {
    throw new CodebookError(`未知代码表「${authority.trim() || authority}」`);
  }
  return codes;
}

function codesInFile(authorities: JsonMap, authority: string): JsonMap | undefined {
  const block = authorities.get(authority);
  if (!(block instanceof JsonMap)) return undefined;
  const codes = block.get('codes');
  if (!(codes instanceof JsonMap)) return undefined;
  return codes;
}

function authorityMap(root: JsonMap): JsonMap {
  const authorities = root.get('authorities');
  if (!(authorities instanceof JsonMap)) {
    throw new Error('代码表缺少 authorities');
  }
  return authorities;
}

function readBindings(file: string): Map<string, BindingRow> {
  let parsed: { bindings?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { bindings?: unknown };
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : '无法读取绑定表');
  }
  if (!parsed.bindings || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings)) {
    throw new Error('绑定表缺少 bindings');
  }
  return new Map(Object.entries(parsed.bindings as Record<string, BindingRow>));
}

function requireEnumField(fieldCode: string) {
  const code = fieldCode.trim();
  if (LEGAL_FIELDS.has(code)) throw new CodebookError('法律结论字段不能添加扩充标签');
  const field = catalogFields.find((item) => item.code === code);
  if (!field) throw new CodebookError(`未知字段「${code}」`);
  if (!field.type.includes('枚举')) throw new CodebookError('只有枚举字段可以添加扩充标签');
  return field;
}

function readCodebook(file: string): JsonMap {
  let text: string;
  try {
    text = fs.readFileSync(file === CODEBOOK_FILE && !fs.existsSync(file) ? path.join(seedDir, 'business_codes.v1.json') : file, 'utf8');
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : '无法读取代码表');
  }
  const value = parseOrderedJson(text);
  if (!(value instanceof JsonMap)) throw new Error('代码表根节点不是对象');
  return value;
}

function writeCodebook(file: string, value: JsonMap): void {
  writeAtomic(file, `${stableJson(value)}\n`);
}

function emptyTag(): JsonMap {
  const root = new JsonMap();
  root.set('schema_version', '1.0');
  root.set('maintained', 'hand');
  root.set('aliases', new JsonMap());
  root.set('query_groups', new JsonMap());
  root.set('extension_tags', new JsonMap());
  root.set('next_ext_seq', 1);
  return root;
}

function readTag(file: string): JsonMap {
  if (!fs.existsSync(file)) {
    if (file !== TAG_LIBRARY_FILE) return emptyTag();
    file = path.join(seedDir, 'tag_library.v1.json');
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : '无法读取标签库');
  }
  if (!text.trim()) return emptyTag();
  const value = parseOrderedJson(text, '标签库 JSON');
  if (!(value instanceof JsonMap)) throw new Error('标签库根节点不是对象');
  return value;
}

function ensureTagShape(root: JsonMap): void {
  if (typeof root.get('schema_version') !== 'string') root.set('schema_version', '1.0');
  if (typeof root.get('maintained') !== 'string') root.set('maintained', 'hand');
  for (const key of ['aliases', 'query_groups', 'extension_tags']) {
    if (!(root.get(key) instanceof JsonMap)) root.set(key, new JsonMap());
  }
  const seq = root.get('next_ext_seq');
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 1) root.set('next_ext_seq', 1);
}

function writeTag(file: string, root: JsonMap): void {
  ensureTagShape(root);
  writeAtomic(file, `${stableJson(root)}\n`);
}

function lookupMap(root: JsonMap, ...keys: string[]): JsonMap | undefined {
  let current: JsonValue | undefined = root;
  for (const key of keys) {
    if (!(current instanceof JsonMap)) return undefined;
    current = current.get(key);
  }
  return current instanceof JsonMap ? current : undefined;
}

function objectChild(parent: JsonMap, key: string): JsonMap {
  const current = parent.get(key);
  if (current instanceof JsonMap) return current;
  const created = new JsonMap();
  parent.set(key, created);
  return created;
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function aliasesFor(tag: JsonMap, authority: string): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const aliases = lookupMap(tag, 'aliases', authority);
  if (!aliases) return grouped;
  for (const [phrase, dmz] of aliases) {
    if (typeof dmz !== 'string') continue;
    const list = grouped.get(dmz) ?? [];
    list.push(phrase);
    grouped.set(dmz, list);
  }
  return grouped;
}

function referencesTo(tag: JsonMap, authority: string, dmz: string): string[] {
  const names: string[] = [];
  const aliases = lookupMap(tag, 'aliases', authority);
  if (aliases) {
    for (const [phrase, target] of aliases) {
      if (target === dmz) names.push(`同义读法「${phrase}」`);
    }
  }
  const groups = lookupMap(tag, 'query_groups', authority);
  if (groups) {
    for (const [name, members] of groups) {
      if (stringList(members).includes(dmz)) names.push(`查询分组「${name}」`);
    }
  }
  return names;
}

function phraseHits(
  phraseKey: string,
  codes: JsonMap | undefined,
  tag: JsonMap,
  authority: string,
  bindings: Map<string, BindingRow>,
  skip: { dmz?: string; groupKey?: string; extCode?: string; fieldCode?: string },
): PhraseHit | undefined {
  if (!phraseKey) return undefined;
  if (codes) {
    for (const [dmz, label] of codes) {
      if (dmz === skip.dmz) continue;
      if (textKey(dmz) === phraseKey) return { kind: 'dmz', name: dmz };
      if (typeof label === 'string' && textKey(label) === phraseKey) return { kind: 'label', name: label };
    }
    const aliases = lookupMap(tag, 'aliases', authority);
    if (aliases) {
      for (const [alias] of aliases) {
        if (textKey(alias) === phraseKey) return { kind: 'alias', name: alias };
      }
    }
    const groups = lookupMap(tag, 'query_groups', authority);
    if (groups) {
      for (const [name] of groups) {
        if (skip.groupKey && textKey(skip.groupKey) === textKey(name)) continue;
        if (textKey(name) === phraseKey) return { kind: 'group', name };
      }
    }
  }
  const extensions = lookupMap(tag, 'extension_tags');
  if (!extensions) return undefined;
  for (const [fieldCode, bucket] of extensions) {
    if (!(bucket instanceof JsonMap)) continue;
    const bound = stringAuthority(bindings.get(fieldCode)?.authority);
    const sameAuthority = Boolean(codes) && bound === authority;
    const sameField = skip.fieldCode === fieldCode;
    if (!sameAuthority && !sameField) continue;
    for (const [extCode, body] of bucket) {
      if (!(body instanceof JsonMap)) continue;
      if (skip.extCode && skip.extCode === extCode) continue;
      const label = body.get('label');
      if (typeof label === 'string' && textKey(label) === phraseKey) {
        return { kind: 'extension', name: label };
      }
      for (const alias of stringList(body.get('aliases'))) {
        if (textKey(alias) === phraseKey) return { kind: 'extension', name: alias };
      }
    }
  }
  return undefined;
}

function cleanAliasList(aliases: string[], label: string): string[] {
  const labelKey = textKey(label);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const alias of aliases) {
    const phrase = requirePhrase(alias, '同义读法');
    const key = textKey(phrase);
    if (key === labelKey || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(phrase);
  }
  return cleaned;
}

function assertExtensionKeys(
  field: (typeof catalogFields)[number],
  label: string,
  aliases: string[],
  tag: JsonMap,
  bindings: Map<string, BindingRow>,
  codeFile: string,
  skipExt?: string,
): void {
  const authority = stringAuthority(bindings.get(field.code)?.authority);
  const codes = authority ? editableCodes(readCodebook(codeFile), bindings, authority) : undefined;
  const names = [label, ...aliases];
  const local = new Set<string>();
  for (const phrase of names) {
    const key = textKey(phrase);
    if (!key) throw new CodebookError('名称不能为空');
    if (local.has(key)) throw new CodebookError(`「${phrase}」在这条扩充标签里重复`);
    local.add(key);
    const hit = phraseHits(key, codes, tag, authority ?? '', bindings, {
      fieldCode: field.code,
      extCode: skipExt,
    });
    if (hit) throw collisionError(phrase, hit);
  }
}

function allocateExt(root: JsonMap): string {
  const stored = root.get('next_ext_seq');
  let seq = typeof stored === 'number' && Number.isFinite(stored) && stored >= 1 ? Math.floor(stored) : 1;
  const used = new Set<string>();
  const tags = lookupMap(root, 'extension_tags');
  if (tags) {
    for (const [, bucket] of tags) {
      if (!(bucket instanceof JsonMap)) continue;
      for (const extCode of bucket.keys()) {
        used.add(extCode);
        const match = /^ext:(\d+)$/.exec(extCode);
        if (match) seq = Math.max(seq, Number(match[1]) + 1);
      }
    }
  }
  while (used.has(`ext:${String(seq).padStart(4, '0')}`)) seq += 1;
  root.set('next_ext_seq', seq + 1);
  return `ext:${String(seq).padStart(4, '0')}`;
}

function findExtension(
  tag: JsonMap,
  extCode: string,
): { fieldCode: string; bucket: JsonMap; body: JsonMap; label: string; aliases: string[] } | undefined {
  const tags = lookupMap(tag, 'extension_tags');
  if (!tags) return undefined;
  for (const [fieldCode, bucket] of tags) {
    if (!(bucket instanceof JsonMap)) continue;
    const body = bucket.get(extCode);
    if (!(body instanceof JsonMap)) continue;
    const label = body.get('label');
    return {
      fieldCode,
      bucket,
      body,
      label: typeof label === 'string' ? label : '',
      aliases: stringList(body.get('aliases')),
    };
  }
  return undefined;
}

export function seedPhraseClassifier() {
  return readPhraseClassifier(path.join(seedDir, 'business_codes.v1.json'), BINDINGS_FILE,
    path.join(seedDir, 'tag_library.v1.json'));
}

export function currentFieldOptions(): CatalogOptions {
  const codeFile = CODEBOOK_FILE;
  const tagFile = TAG_LIBRARY_FILE;
  const tables = authorityMap(readCodebook(codeFile));
  const tag = readTag(tagFile);
  const result: CatalogOptions = {};
  for (const [field, binding] of readBindings(BINDINGS_FILE)) {
    const authority = stringAuthority(binding.authority);
    if (!authority) continue;
    const codes = codesInFile(tables, authority);
    if (!codes) continue;
    const aliases = aliasesFor(tag, authority);
    result[field] = rowsOf(codes).map(({ dmz, label }) => ({
      value: label, code: dmz, aliases: aliases.get(dmz) ?? [],
    }));
  }
  for (const row of listExtensionTags(undefined, codeFile, tagFile)) {
    (result[row.fieldCode] ??= []).push({
      value: row.label, code: row.extCode, aliases: row.aliases, extension: true,
    });
  }
  return result;
}
