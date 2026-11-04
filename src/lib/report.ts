// Errores del servidor → tabla `reports`. noteError() es síncrona (se llama desde ok() justo antes de lanzar) y
// solo anota en el store de la request; el middleware guarda todo con `await flush()` al terminar, así el insert
// no queda flotando cuando Vercel congela la función.
import type { SupabaseClient } from '@supabase/supabase-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { adminClient } from './supabase';

type Noted = { message: string; stack?: string; context?: Record<string, unknown> };
export const requestErrors = new AsyncLocalStorage<Noted[]>();

export function noteError(err: unknown, context?: Record<string, unknown>) {
  console.error(err);
  const e = err as { message?: string; stack?: string };
  // Los errores de PostgREST no son Error: se guardan enteros (code, details, hint) en context.
  const message = String(e?.message ?? err).slice(0, 2000) || 'error';
  requestErrors.getStore()?.push({ message, stack: e?.stack?.slice(0, 8000), context: { ...context, ...(e instanceof Error ? {} : { error: err }) } });
}

export async function flush(errors: Noted[], sb: SupabaseClient, userId: string | undefined, req: Request) {
  if (!errors.length) return;
  const url = new URL(req.url);
  const rows = errors.map((e) => ({
    user_id: userId ?? null,
    kind: 'error',
    source: 'server',
    message: e.message,
    stack: e.stack,
    path: (url.pathname + url.search).slice(0, 500),
    context: { ...e.context, method: req.method, sha: process.env.VERCEL_GIT_COMMIT_SHA },
  }));
  try {
    // Sin sesión (login, Google, invitación) RLS no deja insertar: única excepción a "service role solo en ingest".
    const { error } = await (userId ? sb : adminClient()).from('reports').insert(rows);
    if (error) console.error('reports insert', error);
  } catch (e) {
    console.error('reports insert', e);
  }
}
