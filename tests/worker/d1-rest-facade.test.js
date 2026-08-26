import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('D1 REST facade JSON binding contract', () => {
  it('json_extract round-trips canonical strings, numbers, and null with SQLite types', async () => {
    const row = await env.DB.prepare(
      `SELECT
         json_extract(?, '$') AS text_value,
         typeof(json_extract(?, '$')) AS text_type,
         json_extract(?, '$') AS integer_value,
         typeof(json_extract(?, '$')) AS integer_type,
         json_extract(?, '$') AS real_value,
         typeof(json_extract(?, '$')) AS real_type,
         json_extract(?, '$') AS null_value,
         typeof(json_extract(?, '$')) AS null_type`
    ).bind(
      JSON.stringify('owner'),
      JSON.stringify('owner'),
      JSON.stringify(42),
      JSON.stringify(42),
      JSON.stringify(42.5),
      JSON.stringify(42.5),
      JSON.stringify(null),
      JSON.stringify(null),
    ).first()

    expect(row).toEqual({
      integer_type: 'integer',
      integer_value: 42,
      null_type: 'null',
      null_value: null,
      real_type: 'real',
      real_value: 42.5,
      text_type: 'text',
      text_value: 'owner',
    })
  })
})
