import fs from 'node:fs';
import path from 'node:path';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonMap;

export class JsonMap extends Map<string, JsonValue> {}

export function parseOrderedJson(text: string, label = '代码表 JSON'): JsonValue {
  let i = 0;

  function skip(): void {
    while (i < text.length) {
      const c = text[i];
      if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') break;
      i += 1;
    }
  }

  function fail(message: string): never {
    throw new Error(`${message}，位置 ${i}`);
  }

  function parseValue(): JsonValue {
    skip();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (text.startsWith('true', i)) return literal(4, true);
    if (text.startsWith('false', i)) return literal(5, false);
    if (text.startsWith('null', i)) return literal(4, null);
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail(`${label} 无法解析`);
  }

  function literal(length: number, value: JsonValue): JsonValue {
    i += length;
    return value;
  }

  function parseObject(): JsonMap {
    i += 1;
    const map = new JsonMap();
    skip();
    if (text[i] === '}') {
      i += 1;
      return map;
    }
    for (;;) {
      skip();
      if (text[i] !== '"') fail(`${label} 对象键无效`);
      const key = parseString();
      skip();
      if (text[i] !== ':') fail(`${label} 缺少冒号`);
      i += 1;
      map.set(key, parseValue());
      skip();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return map;
      }
      fail(`${label} 对象未结束`);
    }
  }

  function parseArray(): JsonValue[] {
    i += 1;
    const items: JsonValue[] = [];
    skip();
    if (text[i] === ']') {
      i += 1;
      return items;
    }
    for (;;) {
      items.push(parseValue());
      skip();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return items;
      }
      fail(`${label} 数组未结束`);
    }
  }

  function parseString(): string {
    i += 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        const escaped = text[i + 1];
        if (escaped === '"' || escaped === '\\' || escaped === '/') {
          out += escaped;
          i += 2;
          continue;
        }
        if (escaped === 'b') out += '\b';
        else if (escaped === 'f') out += '\f';
        else if (escaped === 'n') out += '\n';
        else if (escaped === 'r') out += '\r';
        else if (escaped === 't') out += '\t';
        else if (escaped === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(`${label} 转义无效`);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        } else {
          fail(`${label} 转义无效`);
        }
        i += 2;
        continue;
      }
      if (c < ' ') fail(`${label} 字符串含控制字符`);
      out += c;
      i += 1;
    }
    fail(`${label} 字符串未结束`);
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === '-') i += 1;
    if (text[i] === '0') i += 1;
    else if (text[i] >= '1' && text[i] <= '9') {
      while (text[i] >= '0' && text[i] <= '9') i += 1;
    } else {
      fail(`${label} 数字无效`);
    }
    if (text[i] === '.') {
      i += 1;
      if (text[i] < '0' || text[i] > '9') fail(`${label} 数字无效`);
      while (text[i] >= '0' && text[i] <= '9') i += 1;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      if (text[i] < '0' || text[i] > '9') fail(`${label} 数字无效`);
      while (text[i] >= '0' && text[i] <= '9') i += 1;
    }
    return JSON.parse(text.slice(start, i)) as number;
  }

  const value = parseValue();
  skip();
  if (i !== text.length) fail(`${label} 末尾有多余内容`);
  return value;
}

export function stableJson(value: JsonValue): string {
  return writeJson(value, 0);
}

function writeJson(value: JsonValue, depth: number): string {
  if (value instanceof JsonMap) {
    if (value.size === 0) return '{}';
    const pad = ' '.repeat(depth * 2);
    const inner = ' '.repeat((depth + 1) * 2);
    const lines: string[] = [];
    for (const [key, item] of value) {
      lines.push(`${inner}${JSON.stringify(key)}: ${writeJson(item, depth + 1)}`);
    }
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(depth * 2);
    const inner = ' '.repeat((depth + 1) * 2);
    const lines = value.map((item) => `${inner}${writeJson(item, depth + 1)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function writeAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        fd = null;
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
