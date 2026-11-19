import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodebookError,
  addAlias,
  addCode,
  createExtensionTag,
  expandQuery,
  listCodes,
  listGroups,
  pageCodes,
  putQueryGroup,
  removeAlias,
  removeCode,
  removeExtensionTag,
  renameCode,
} from './codebook';

const CODE_TEXT = `{
  "maintained": "hand",
  "source": {
    "registry": "getInitCode"
  },
  "authorities": {
    "tq": {
      "codes": {
        "1": "晴",
        "19": "其它",
        "2": "阴"
      }
    },
    "wfxw": {
      "codes": {
        "1005": "无证驾驶"
      }
    },
    "extra": {
      "codes": {
        "9": "局外"
      }
    }
  }
}
`;

function tempFiles(): { dir: string; codeFile: string; bindingFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebook-'));
  const codeFile = path.join(dir, 'business_codes.v1.json');
  const bindingFile = path.join(dir, 'code_bindings.v1.json');
  fs.writeFileSync(codeFile, CODE_TEXT);
  fs.writeFileSync(
    bindingFile,
    `${JSON.stringify(
      {
        bindings: {
          'D07.F041': { authority: 'tq' },
          'D10.F058': { authority: 'wfxw', legal_conclusion: true },
          'D01.F001': { authority: null, reason: '标识 sgbh，不查码表' },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { dir, codeFile, bindingFile };
}

test('add appends a code and rejects a label already used by another dmz', () => {
  const { dir, codeFile, bindingFile } = tempFiles();
  try {
    const before = fs.readFileSync(codeFile, 'utf8');
    assert.throws(
      () => addCode('extra', '1', '新局外', codeFile, bindingFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('extra'),
    );
    assert.equal(fs.readFileSync(codeFile, 'utf8'), before);

    addCode('tq', '3', '雨', codeFile, bindingFile);
    assert.deepEqual(
      listCodes('tq', codeFile, bindingFile).map((row) => row.dmz),
      ['1', '19', '2', '3'],
    );

    assert.throws(
      () => addCode('tq', '4', '雨', codeFile, bindingFile),
      (err: unknown) => {
        assert.ok(err instanceof CodebookError);
        assert.match(err.message, /已被代码 3 使用/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rename changes a label and allows keeping the same label', () => {
  const { dir, codeFile, bindingFile } = tempFiles();
  try {
    assert.throws(
      () => renameCode('tq', '2', '晴', codeFile, bindingFile),
      (err: unknown) => {
        assert.ok(err instanceof CodebookError);
        assert.match(err.message, /已被代码 1 使用/);
        return true;
      },
    );

    renameCode('tq', '2', '阴天', codeFile, bindingFile);
    assert.equal(
      listCodes('tq', codeFile, bindingFile).find((row) => row.dmz === '2')?.label,
      '阴天',
    );

    const before = fs.readFileSync(codeFile, 'utf8');
    renameCode('tq', '2', ' 阴天 ', codeFile, bindingFile);
    assert.equal(fs.readFileSync(codeFile, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove restores the exact file bytes', () => {
  const { dir, codeFile, bindingFile } = tempFiles();
  try {
    assert.throws(
      () => removeCode('tq', 'missing', codeFile, bindingFile),
      (err: unknown) => err instanceof CodebookError,
    );
    const before = fs.readFileSync(codeFile);
    addCode('tq', '99', '阵雨', codeFile, bindingFile);
    assert.notEqual(fs.readFileSync(codeFile).equals(before), true);
    removeCode('tq', '99', codeFile, bindingFile);
    assert.equal(fs.readFileSync(codeFile).equals(before), true);
    assert.throws(
      () => removeCode('wfxw', '1005', codeFile, bindingFile),
      (err: unknown) => {
        assert.ok(err instanceof CodebookError);
        assert.match(err.message, /最后一条代码/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(codeFile).equals(before), true);
    assert.deepEqual(
      listCodes('tq', codeFile, bindingFile).map((row) => [row.dmz, row.label]),
      [
        ['1', '晴'],
        ['19', '其它'],
        ['2', '阴'],
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pageCodes returns a window and matches code or label', () => {
  const { dir, codeFile, bindingFile } = tempFiles();
  try {
    const first = pageCodes('tq', '', 0, 2, codeFile, bindingFile);
    assert.equal(first.total, 3);
    assert.deepEqual(first.codes.map((row) => row.dmz), ['1', '19']);
    const rest = pageCodes('tq', '', 2, 2, codeFile, bindingFile);
    assert.deepEqual(rest.codes.map((row) => [row.dmz, row.label]), [['2', '阴']]);
    const byLabel = pageCodes('tq', '阴', 0, 40, codeFile, bindingFile);
    assert.deepEqual(byLabel.codes.map((row) => row.dmz), ['2']);
    const byCode = pageCodes('tq', '19', 0, 40, codeFile, bindingFile);
    assert.deepEqual(byCode.codes.map((row) => row.dmz), ['19']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listGroups marks legal conclusions and keeps unbound reasons', () => {
  const { dir, codeFile, bindingFile } = tempFiles();
  try {
    const { groups, unbound } = listGroups(codeFile, bindingFile);
    assert.deepEqual(
      groups.map((group) => group.authority),
      ['tq', 'wfxw'],
    );
    const weather = groups[0];
    assert.equal(weather.legal, false);
    assert.equal(weather.count, 3);
    assert.deepEqual(weather.fields, [{ code: 'D07.F041', name: '天气现象' }]);
    const violation = groups[1];
    assert.equal(violation.legal, true);
    assert.deepEqual(violation.fields, [{ code: 'D10.F058', name: '认定违法行为' }]);
    assert.deepEqual(unbound, [
      { code: 'D01.F001', name: '事故业务编号', reason: '标识 sgbh，不查码表' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function libraryFiles(): { dir: string; codeFile: string; bindingFile: string; tagFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-library-'));
  const codeFile = path.join(dir, 'business_codes.v1.json');
  const bindingFile = path.join(dir, 'code_bindings.v1.json');
  const tagFile = path.join(dir, 'tag_library.v1.json');
  fs.writeFileSync(
    codeFile,
    `{
  "authorities": {
    "tq": { "codes": { "1": "晴", "2": "阴" } },
    "cllx": { "codes": { "M11": "普通二轮摩托车", "M12": "轻便二轮摩托车", "M22": "轻便三轮摩托车" } }
  }
}
`,
  );
  fs.writeFileSync(
    bindingFile,
    `${JSON.stringify({
      bindings: {
        'D07.F041': { authority: 'tq' },
        'D04.F021': { authority: 'cllx' },
        'D06.F036': { authority: null, reason: '隔离防护无平台码表' },
        'D10.F058': { authority: 'wfxw', legal_conclusion: true },
      },
    })}\n`,
  );
  return { dir, codeFile, bindingFile, tagFile };
}

test('aliases, query groups, and expansion stay beside the standard codes', () => {
  const { dir, codeFile, bindingFile, tagFile } = libraryFiles();
  try {
    assert.throws(
      () => addAlias('tq', '19', '2', codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('纯数字'),
    );
    const alias = addAlias('tq', '阴天', '2', codeFile, bindingFile, tagFile);
    assert.deepEqual(alias, { phrase: '阴天', dmz: '2', label: '阴' });
    assert.throws(
      () => addCode('tq', '8', '阴天', codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('阴天'),
    );
    assert.throws(
      () => removeCode('tq', '2', codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && /同义读法「阴天」/.test((err as Error).message),
    );
    const group = putQueryGroup('cllx', '摩托车', ['M11', 'M12', 'M22', 'M11'], codeFile, bindingFile, tagFile);
    assert.deepEqual(group.members.map((member) => member.dmz), ['M11', 'M12', 'M22']);
    assert.deepEqual(expandQuery('D07.F041', '阴天', codeFile, bindingFile, tagFile), {
      fieldCode: 'D07.F041',
      authority: 'tq',
      dmz: ['2'],
      extension: null,
      via: 'alias',
    });
    assert.equal(expandQuery('D04.F021', '摩托车', codeFile, bindingFile, tagFile).via, 'group');
    assert.deepEqual(expandQuery('D04.F021', 'M11', codeFile, bindingFile, tagFile).dmz, ['M11']);
    removeAlias('tq', '阴天', codeFile, bindingFile, tagFile);
    assert.equal(expandQuery('D07.F041', '阴天', codeFile, bindingFile, tagFile).via, 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension tags stay off the standard code table and reject legal fields', () => {
  const { dir, codeFile, bindingFile, tagFile } = libraryFiles();
  try {
    const before = fs.readFileSync(codeFile);
    assert.throws(
      () => createExtensionTag('D10.F058', '闯红灯', [], codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('法律结论'),
    );
    assert.throws(
      () => createExtensionTag('D09.F053', '死亡人数', [], codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('枚举'),
    );
    const first = createExtensionTag('D06.F036', '路侧绿植遮挡', ['视线受路侧绿植遮挡'], codeFile, bindingFile, tagFile);
    const second = createExtensionTag('D06.F036', '中央护栏缺失', [], codeFile, bindingFile, tagFile);
    assert.equal(first.extCode, 'ext:0001');
    assert.equal(second.extCode, 'ext:0002');
    assert.equal(expandQuery('D06.F036', '视线受路侧绿植遮挡', codeFile, bindingFile, tagFile).extension, 'ext:0001');
    removeExtensionTag(first.extCode, codeFile, tagFile);
    const third = createExtensionTag('D06.F036', '机非隔离不连续', [], codeFile, bindingFile, tagFile);
    assert.equal(third.extCode, 'ext:0003');
    assert.equal(expandQuery('D06.F036', '视线受路侧绿植遮挡', codeFile, bindingFile, tagFile).via, 'none');
    assert.equal(fs.readFileSync(codeFile).equals(before), true);
    assert.throws(
      () => createExtensionTag('D07.F041', '阴', [], codeFile, bindingFile, tagFile),
      (err: unknown) => err instanceof CodebookError && err.message.includes('阴'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
