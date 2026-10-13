import { describe, expect, it } from 'vitest';
import { attachmentPreview, formatFileSize, normalizeMimeType, uploadAttachmentQuerySchema } from './attachments.js';

describe('附件 helpers', () => {
  it.each([
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/webp', 'image'],
    ['application/pdf', 'pdf'],
    ['image/svg+xml', null], // can carry script: download only
    ['text/html', null],
    ['application/octet-stream', null],
  ] as const)('previews %s as %s', (mime, preview) => {
    expect(attachmentPreview(mime)).toBe(preview);
  });

  it.each([
    ['image/PNG', 'image/png'],
    ['text/html; charset=utf-8', 'text/html'],
    [undefined, 'application/octet-stream'],
    ['', 'application/octet-stream'],
    ['nonsense', 'application/octet-stream'],
    ['text/html\r\nx-evil: 1', 'application/octet-stream'],
  ])('normalises Content-Type %j to %s', (input, expected) => {
    expect(normalizeMimeType(input)).toBe(expected);
  });

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [50 * 1024 * 1024, '50 MB'],
    [12_345_678, '12 MB'],
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatFileSize(bytes)).toBe(text);
  });

  it('accepts ordinary file names, rejects paths and control characters', () => {
    expect(uploadAttachmentQuerySchema.safeParse({ name: ' 发票 (1).pdf ' }).data).toEqual({ name: '发票 (1).pdf' });
    for (const name of ['', '   ', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(256)]) {
      expect(uploadAttachmentQuerySchema.safeParse({ name }).success, JSON.stringify(name)).toBe(false);
    }
  });
});
