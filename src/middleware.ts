import { defineMiddleware } from 'astro:middleware';
import { flush, noteError, requestErrors } from './lib/report';
import { userClient } from './lib/supabase';

// /_actions/* se deja pasar: cada action valida la sesión en su handler.
const PUBLIC = ['/login', '/auth/callback', '/api/ingest'];

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.supabase = userClient(ctx.request, ctx.cookies);
  const { data } = await ctx.locals.supabase.auth.getClaims();
  ctx.locals.userId = data?.claims.sub;

  const path = ctx.url.pathname;
  if (!ctx.locals.userId && !PUBLIC.includes(path) && !path.startsWith('/_actions/')) {
    return ctx.redirect('/login');
  }
  const errors: Parameters<typeof flush>[0] = [];
  try {
    return await requestErrors.run(errors, next);
  } catch (err) {
    requestErrors.run(errors, () => noteError(err));
    throw err;
  } finally {
    await flush(errors, ctx.locals.supabase, ctx.locals.userId, ctx.request);
  }
});
