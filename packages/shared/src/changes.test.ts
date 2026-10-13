import { describe, expect, it } from 'vitest';
import { changesQuerySchema, changesResponseSchema } from './changes.js';

describe('changesQuerySchema', () => {
  it.each([
    [{}, 0],
    [{ since: '0' }, 0],
    [{ since: '42' }, 42],
  ])('accepts %j as since=%i', (query, since) => {
    expect(changesQuerySchema.parse(query)).toEqual({ since });
  });

  it.each([[{ since: '-1' }], [{ since: 'abc' }], [{ since: '1.5' }], [{ since: '' }]])(
    'rejects %j',
    (query) => {
      expect(changesQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});

describe('changesResponseSchema', () => {
  it('accepts upserts and tombstones keyed by entity type', () => {
    const body = {
      revision: 3,
      entities: {
        list: {
          upserts: [{ id: '0190a8a4-5b8e-7c1a-9d3e-1f2a3b4c5d6e', revision: 1 }],
          tombstones: [
            {
              id: '0190a8a4-5b8e-7c1a-9d3e-1f2a3b4c5d6f',
              revision: 3,
              deletedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      },
    };
    expect(changesResponseSchema.parse(body)).toEqual(body);
  });
});
