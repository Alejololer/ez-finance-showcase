// Recibe texto crudo de Gmail (Apps Script), Android (MacroDroid) o iOS (Atajos).
// Solo guarda; la interpretación la hace scripts/parse-pending.ts en GitHub Actions.
import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GITHUB_DISPATCH_TOKEN } from 'astro:env/server';
import { adminClient } from '../../lib/supabase';

const MAX_BYTES = 16_384;
const REPO = 'Alejololer/ez-finance-v2';
const Body = z.object({
  source: z.enum(['email', 'android', 'ios']),
  text: z.string().trim().min(1).max(16_000),
  received_at: z.string().optional(),
});
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const reply = (status: number, error?: string) => Response.json(error ? { error } : { ok: true }, { status });

export const POST: APIRoute = async ({ request }) => {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/)?.[1];
  if (!token) return reply(401, 'unauthorized');

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BYTES) return reply(413, 'too large');
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(text));
  } catch {
    return reply(400, 'invalid body');
  }

  const db = adminClient();
  const { data: owner, error: tokenError } = await db
    .from('ingest_tokens')
    .select('user_id')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (tokenError) return reply(500, 'db error');
  if (!owner) return reply(401, 'unauthorized');

  const received = body.received_at ? new Date(body.received_at) : new Date();
  const { data: inserted, error } = await db
    .from('ingest_events')
    .upsert(
      {
        user_id: owner.user_id,
        source: body.source,
        raw: body.text,
        raw_hash: sha256(body.text.replace(/\s+/g, ' ')),
        received_at: (isNaN(+received) ? new Date() : received).toISOString(),
      },
      { onConflict: 'user_id,raw_hash', ignoreDuplicates: true },
    )
    .select('id');
  if (error) return reply(500, 'db error');
  if (inserted.length) await dispatchParser();
  return reply(202);
};

// Arranca el workflow ya, en vez de esperar al cron. Si falla, el cron lo levanta igual: nunca bloquea el ingest.
// GitHub mantiene como máximo una corrida en espera, así que una ráfaga de avisos no multiplica corridas.
async function dispatchParser() {
  if (!GITHUB_DISPATCH_TOKEN) return;
  try {
    await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/parse.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}
