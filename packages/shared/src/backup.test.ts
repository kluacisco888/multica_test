import { describe, expect, it } from 'vitest';
import { backupDocumentSchema, describeImportIssue, toCsv } from './backup.js';

describe('toCsv', () => {
  it('quotes fields with commas, quotes and line breaks; CRLF line ends', () => {
    expect(toCsv([['标题', '描述'], ['a,b', 'say "hi"\n第二行']])).toBe('标题,描述\r\n"a,b","say ""hi""\n第二行"\r\n');
  });

  it('leaves plain fields and empty fields alone', () => {
    expect(toCsv([['买菜', '', '高']])).toBe('买菜,,高\r\n');
  });

  it('neutralises fields a spreadsheet would run as a formula', () => {
    expect(toCsv([['=1+1', '+86', '-5', '@SUM(A1)', '1=1']])).toBe("'=1+1,'+86,'-5,'@SUM(A1),1=1\r\n");
  });
});

describe('backupDocumentSchema', () => {
  const doc = { format: 'dida-clone-backup', version: 1, exportedAt: '2026-10-14T00:00:00.000Z', entities: { task: [] } };

  it('accepts a backup envelope', () => {
    expect(backupDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it.each([
    [{ ...doc, format: 'ticktick' }, '不是本应用导出的备份文件'],
    [{ ...doc, version: 2 }, '不支持这个版本的备份文件'],
    [{ ...doc, entities: { task: {} } }, '每类数据都应该是一个数组'],
  ])('rejects %j', (input, message) => {
    const parsed = backupDocumentSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });
});

describe('describeImportIssue', () => {
  it('names the entity in Chinese with the 1-based position and id', () => {
    expect(describeImportIssue({ entity: 'task', index: 3, id: 'abc', message: '清单不存在' })).toBe('任务 第 3 条（id abc）：清单不存在');
  });

  it('names the line of a 滴答清单 CSV', () => {
    expect(describeImportIssue({ entity: 'ticktickCsv', index: 9, id: null, message: '提醒不合法' })).toBe('第 9 行：提醒不合法');
    expect(describeImportIssue({ entity: 'ticktickCsv', index: 0, id: null, message: '不是滴答清单的备份文件' })).toBe('不是滴答清单的备份文件');
  });

  it('leaves out the position for file-level problems', () => {
    expect(describeImportIssue({ entity: 'unknown', index: 0, id: null, message: '不认识的数据类型' })).toBe('unknown：不认识的数据类型');
  });
});
