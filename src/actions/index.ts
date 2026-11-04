import { ActionError, defineAction } from 'astro:actions';
import { z } from 'astro/zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GITHUB_DISPATCH_TOKEN, VAPID_PRIVATE_KEY } from 'astro:env/server';
import { PUBLIC_VAPID_PUBLIC_KEY } from 'astro:env/client';
import { cycle, parseTiers } from '../lib/card';
import { toCents, today } from '../lib/money';
import { APP_URL, sendPush, testNotice } from '../lib/push';
import { noteError } from '../lib/report';

// Las actions son endpoints públicos (/_actions/*): cada handler valida la sesión aquí.
function db(ctx: { locals: App.Locals }) {
  if (!ctx.locals.userId) throw new ActionError({ code: 'UNAUTHORIZED', message: 'Inicia sesión de nuevo' });
  return ctx.locals.supabase;
}
function ok<T>(r: { data: T; error: { message: string } | null }, message = 'No se pudo guardar') {
  if (r.error) {
    noteError(r.error); // el mensaje real queda en `reports`; al usuario solo el genérico
    throw new ActionError({ code: 'BAD_REQUEST', message });
  }
  return r.data;
}

const id = z.coerce.number().int().positive();
// Astro envía los campos ausentes de un form como null (no undefined): por eso .nullish() y no .optional().
const optId = z.string().nullish().transform((v) => (v ? Number(v) : null));
const amount = z.string().transform(toCents).pipe(z.number({ error: 'Monto inválido' }).int().positive().max(100_000_000));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const kind = z.enum(['expense', 'income']);
// Últimos dígitos de la cuenta y sus tarjetas: "7105, 5518. 458" → "7105,5518,458" (punto: el teclado decimal de iOS no tiene coma en todas las regiones)
const last4 = z
  .string()
  .trim()
  .regex(/^(\d{3,4}([\s,.]+\d{3,4}){0,9})?$/, 'Grupos de 3 o 4 dígitos separados por coma o punto, ej. 7105, 458')
  .transform((v) => (v ? [...new Set(v.split(/[\s,.]+/))].join(',') : null));
// Día del mes (corte/pago) opcional: "" → null
const monthDay = z
  .string()
  .nullish()
  .transform((v) => (v ? Number(v) : null))
  .pipe(z.number({ error: 'Día inválido' }).int().min(1, 'Entre 1 y 31').max(31, 'Entre 1 y 31').nullable());
// Monto opcional en dólares: "" → null
const optAmount = z.string().trim().nullish().transform((v) => (v ? toCents(v) : null))
  .pipe(z.number({ error: 'Monto inválido, ej. 5 o 5.50' }).int().positive('Debe ser mayor a 0').max(100_000).nullable());
const signed = (k: 'expense' | 'income', cents: number) => (k === 'expense' ? -cents : cents);
// Botón "con IVA" (solo gastos): una fila más con el 15 % (IVA de Ecuador) que el banco cobra aparte y sin aviso,
// ej. servicios digitales del exterior. Truncado como el banco: $6.99 → $1.04.
const iva = z.string().nullish();
const ivaTx = <T extends { merchant: string | null }>(cents: number, tx: T) =>
  ({ ...tx, kind: 'expense', amount_cents: -Math.floor((cents * 15) / 100), merchant: tx.merchant ? `IVA ${tx.merchant}` : 'IVA' });
const NL = '\n'; // cuerpo del issue de sendReport
const pct = z.string().trim().transform((v) => Number(v.replace(',', '.')))
  .pipe(z.number({ error: 'Porcentaje inválido, ej. 40.9' }).gt(0, 'Debe ser mayor a 0').max(100, 'Máximo 100'));
const dueDay = z.coerce.number({ error: 'Día inválido' }).int().min(1, 'Entre 1 y 31').max(31, 'Entre 1 y 31');

// Una fila en la cuenta común de otra persona es de su titular (FK compuesta (account_id, user_id)) y lleva una
// categoría de la titular: se usa la del mismo nombre (las 10 base existen en todas), o ninguna.
async function place(sb: ReturnType<typeof db>, account_id: number, category_id: number | null = null) {
  const { user_id } = ok(await sb.from('accounts').select('user_id').eq('id', account_id).single(), 'Cuenta no encontrada')!;
  if (category_id) {
    const cat = ok(await sb.from('categories').select('user_id, name').eq('id', category_id).single())!;
    if (cat.user_id !== user_id) {
      const same = ok(await sb.from('categories').select('id').eq('user_id', user_id).eq('name', cat.name).maybeSingle());
      category_id = same?.id ?? null;
    }
  }
  return { user_id, category_id };
}

export const server = {
  login: defineAction({
    accept: 'form',
    input: z.object({ email: z.email('Correo inválido'), password: z.string().min(6, 'Mínimo 6 caracteres'), mode: z.enum(['login', 'signup']) }),
    handler: async ({ email, password, mode }, ctx) => {
      const auth = ctx.locals.supabase.auth;
      const { error } =
        mode === 'login'
          ? await auth.signInWithPassword({ email, password })
          : await auth.signUp({ email, password, options: { emailRedirectTo: new URL('/auth/callback', ctx.url).href } });
      if (error) {
        throw new ActionError({
          code: 'BAD_REQUEST',
          message: mode === 'login' ? 'Correo o contraseña incorrectos' : 'No se pudo crear la cuenta. El piloto es solo por invitación.',
        });
      }
      return { mode };
    },
  }),

  google: defineAction({
    accept: 'form',
    handler: async (_, ctx) => {
      const { data, error } = await ctx.locals.supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: new URL('/auth/callback', ctx.url).href },
      });
      if (error) throw new ActionError({ code: 'BAD_REQUEST', message: 'No se pudo iniciar sesión con Google' });
      return { url: data.url };
    },
  }),

  logout: defineAction({
    accept: 'form',
    handler: async (_, ctx) => {
      await ctx.locals.supabase.auth.signOut();
    },
  }),

  createAccount: defineAction({
    accept: 'form',
    input: z.object({
      name: z.string().trim().min(1, 'Escribe un nombre').max(60),
      type: z.enum(['checking', 'savings', 'credit', 'cash']),
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Código de 3 letras, ej. USD'),
      last4,
      is_default: z.boolean().optional(),
    }),
    handler: async (input, ctx) => {
      const sb = db(ctx);
      if (input.is_default) ok(await sb.from('accounts').update({ is_default: false }).eq('is_default', true));
      ok(await sb.from('accounts').insert({ ...input, is_default: !!input.is_default }));
    },
  }),

  updateAccount: defineAction({
    accept: 'form',
    input: z.object({
      id,
      name: z.string().trim().min(1, 'Escribe un nombre').max(60),
      type: z.enum(['checking', 'savings', 'credit', 'cash']),
      last4,
      is_default: z.boolean().optional(),
      // Solo aplican a tarjetas de crédito; para otros tipos se limpian.
      statement_day: monthDay,
      due_day: monthDay,
      pay_from_account_id: optId,
      // "5" (fijo) o "35000: 5, 50000: 6.50" (hasta $35,000 de deuda → $5…); vacío = sin desgravamen
      monthly_fee_tiers: z.string().trim().nullish().transform((v, c) => {
        if (!v) return null;
        const tiers = parseTiers(v);
        if (!tiers) c.addIssue({ code: 'custom', message: 'Desgravamen inválido: un monto (5) o tramos "tope: monto" (35000: 5, 50000: 6.50)' });
        return tiers;
      }),
      annual_fee_cents: optAmount,
      annual_fee_month: monthDay,
      // Interés anual en %: "4.75" o "4,75"; vacío = no genera
      interest_rate: z.string().nullish().transform((v) => (v ? Number(v.replace(',', '.')) : null))
        .pipe(z.number({ error: 'Tasa inválida' }).gt(0, 'La tasa debe ser mayor a 0').lt(100, 'La tasa debe ser menor a 100').nullable()),
    }).refine((v) => v.pay_from_account_id !== v.id, { message: 'Una tarjeta no se paga desde sí misma', path: ['pay_from_account_id'] })
      .refine((v) => !v.annual_fee_cents || (v.annual_fee_month && v.annual_fee_month <= 12),
        { message: 'Elige el mes en que se cobra el costo anual', path: ['annual_fee_month'] }),
    handler: async ({ id, is_default, statement_day, due_day, pay_from_account_id, interest_rate, monthly_fee_tiers, annual_fee_cents, annual_fee_month, ...rest }, ctx) => {
      const sb = db(ctx);
      // Corte/pago/cargos solo en tarjetas; interés solo en las demás.
      const card = rest.type === 'credit'
        ? { statement_day, due_day, pay_from_account_id, monthly_fee_tiers, annual_fee_cents, annual_fee_month: annual_fee_cents ? annual_fee_month : null, interest_rate: null }
        : { statement_day: null, due_day: null, pay_from_account_id: null, monthly_fee_tiers: null, annual_fee_cents: null, annual_fee_month: null, interest_rate };
      if (is_default) ok(await sb.from('accounts').update({ is_default: false }).eq('is_default', true).neq('id', id));
      ok(await sb.from('accounts').update({ ...rest, ...card, is_default: !!is_default }).eq('id', id));
    },
  }),

  setBalance: defineAction({
    accept: 'form',
    input: z.object({
      id,
      balance: z.string().trim().regex(/^-?\d+([.,]\d{1,2})?$/, 'Monto inválido, ej. 1250.50 o -300')
        .transform((v) => (v.startsWith('-') ? -toCents(v.slice(1)) : toCents(v))),
    }),
    handler: async ({ id, balance }, ctx) => {
      const sb = db(ctx);
      const current = ok(await sb.from('account_balances').select('balance_cents').eq('id', id).single());
      const diff = balance - current!.balance_cents; // .single() ya falla si la cuenta no es del usuario
      if (diff === 0) return;
      ok(
        await sb.from('transactions').insert({
          ...(await place(sb, id)), account_id: id, amount_cents: diff, date: today(), kind: 'adjustment', description: 'Ajuste de saldo',
        }),
      );
    },
  }),

  // "Pago de contado" que muestra el banco para el último corte de una tarjeta. Manda sobre el cálculo de la app, que
  // cuenta compras que el banco factura recién en el corte siguiente. Vacío = volver al cálculo de la app.
  setCardStatement: defineAction({
    accept: 'form',
    input: z.object({
      id,
      billed: z.string().trim().nullish().transform((v) => (v ? toCents(v) : null))
        .pipe(z.number({ error: 'Monto inválido, ej. 13.06' }).int().min(0).max(100_000_000).nullable()),
    }),
    handler: async ({ id, billed }, ctx) => {
      const sb = db(ctx);
      const card = ok(await sb.from('accounts').select('statement_day, due_day').eq('id', id).eq('type', 'credit').single());
      if (!card?.statement_day || !card.due_day) throw new ActionError({ code: 'BAD_REQUEST', message: 'Configura el día de corte y de pago en "editar"' });
      const date = cycle(card.statement_day, card.due_day, today()).lastClose;
      if (billed === null) ok(await sb.from('statements').delete().eq('account_id', id).eq('date', date));
      else ok(await sb.from('statements').upsert({ account_id: id, date, balance_cents: -billed }, { onConflict: 'account_id,date' }));
    },
  }),

  createCategory: defineAction({
    accept: 'form',
    input: z.object({ name: z.string().trim().min(1, 'Escribe un nombre').max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
    handler: async (input, ctx) => {
      ok(await db(ctx).from('categories').insert(input), 'Ya existe una categoría con ese nombre');
    },
  }),

  createTransaction: defineAction({
    accept: 'form',
    input: z.object({
      kind, amount, date,
      account_id: id,
      category_id: optId,
      merchant: text(120),
      description: text(500),
      ingest_event_id: optId,
      iva,
    }),
    handler: async ({ kind, amount, ingest_event_id, iva, ...input }, ctx) => {
      const sb = db(ctx);
      const rest = { ...input, ...(await place(sb, input.account_id, input.category_id)) };
      const tx ={ ...rest, kind, amount_cents: signed(kind, amount), ingest_event_id };
      ok(await sb.from('transactions').insert(iva && kind === 'expense' ? [tx, ivaTx(amount, rest)] : [tx]));
      if (ingest_event_id) ok(await sb.from('ingest_events').update({ status: 'parsed' }).eq('id', ingest_event_id));
    },
  }),

  createTransfer: defineAction({
    accept: 'form',
    input: z
      .object({ from_id: id, to_id: id, amount, date, description: text(500), ingest_event_id: optId })
      .refine((v) => v.from_id !== v.to_id, { message: 'Elige dos cuentas distintas', path: ['to_id'] }),
    handler: async ({ from_id, to_id, amount, date, description, ingest_event_id }, ctx) => {
      const sb = db(ctx);
      const base = { date, description, kind: 'transfer', transfer_id: randomUUID(), ingest_event_id };
      // Un solo insert con dos filas = una sola sentencia, atómica.
      ok(
        await sb.from('transactions').insert([
          { ...base, ...(await place(sb, from_id)), account_id: from_id, amount_cents: -amount },
          { ...base, ...(await place(sb, to_id)), account_id: to_id, amount_cents: amount },
        ]),
      );
      if (ingest_event_id) ok(await sb.from('ingest_events').update({ status: 'parsed' }).eq('id', ingest_event_id));
    },
  }),

  confirmTransfer: defineAction({
    accept: 'form',
    input: z
      .object({ transfer_id: z.uuid(), from_id: id, to_id: id, amount, date, description: text(500) })
      .refine((v) => v.from_id !== v.to_id, { message: 'Elige dos cuentas distintas', path: ['to_id'] }),
    handler: async ({ transfer_id, from_id, to_id, amount, ...rest }, ctx) => {
      const sb = db(ctx);
      const [from, to] = await Promise.all([place(sb, from_id), place(sb, to_id)]);
      const leg = (account_id: number, amount_cents: number, owner: typeof from) =>
        sb.from('transactions').update({ ...rest, ...owner, duplicate_of: null, account_id, amount_cents })
          .eq('transfer_id', transfer_id).eq('status', 'pending');
      ok(await leg(from_id, -amount, from).lt('amount_cents', 0)); // pata de salida
      ok(await leg(to_id, amount, to).gt('amount_cents', 0)); // pata de entrada
      // Las ediciones de arriba dejan el par pendiente si algo falla; confirmar ambas patas es una sola sentencia.
      ok(await sb.from('transactions').update({ status: 'confirmed' }).eq('transfer_id', transfer_id).eq('status', 'pending'));
    },
  }),

  confirmTransaction: defineAction({
    accept: 'form',
    input: z.object({ id, kind, amount, date, account_id: id, category_id: optId, merchant: text(120), iva }),
    handler: async ({ id, kind, amount, iva, ...input }, ctx) => {
      const sb = db(ctx);
      const rest = { ...input, ...(await place(sb, input.account_id, input.category_id)) };
      const done = ok(
        await sb
          .from('transactions')
          .update({ ...rest, kind, amount_cents: signed(kind, amount), status: 'confirmed', duplicate_of: null })
          .eq('id', id)
          .eq('status', 'pending')
          .select('id'),
      );
      // Solo si esta vez se confirmó: un doble envío no duplica el IVA.
      if (iva && kind === 'expense' && done?.length) ok(await sb.from('transactions').insert(ivaTx(amount, rest)));
    },
  }),

  // Solo la categoría de un gasto/ingreso ya confirmado (lo pendiente se edita en la bandeja).
  setCategory: defineAction({
    accept: 'form',
    input: z.object({ id, category_id: optId }),
    handler: async ({ id, category_id }, ctx) => {
      const sb = db(ctx);
      const tx = ok(await sb.from('transactions').select('account_id').eq('id', id).single(), 'Movimiento no encontrado')!;
      const owner = await place(sb, tx.account_id, category_id); // cuenta común: categoría de la titular, por nombre
      ok(await sb.from('transactions').update({ category_id: owner.category_id })
        .eq('id', id).eq('status', 'confirmed').in('kind', ['expense', 'income']));
    },
  }),

  discardTransaction: defineAction({
    accept: 'form',
    input: z.object({ id: id.nullish(), transfer_id: z.uuid().nullish() }),
    handler: async ({ id, transfer_id }, ctx) => {
      const q = db(ctx).from('transactions').delete().eq('status', 'pending');
      // Una transferencia se descarta entera (ambas patas).
      if (transfer_id) ok(await q.eq('transfer_id', transfer_id));
      else if (id) ok(await q.eq('id', id));
    },
  }),

  // Borrar un movimiento ya registrado (confirmado por error). Solo llega el id: si es transferencia, el servidor
  // borra ambas patas, y se niega si no ve las dos (la otra está en una cuenta ajena: quedaría coja).
  deleteTransaction: defineAction({
    accept: 'form',
    input: z.object({ id }),
    handler: async ({ id }, ctx) => {
      const sb = db(ctx);
      const tx = ok(await sb.from('transactions').select('transfer_id').eq('id', id).maybeSingle());
      if (!tx) throw new ActionError({ code: 'NOT_FOUND', message: 'Movimiento no encontrado' });
      if (tx.transfer_id) {
        const legs = ok(await sb.from('transactions').select('id').eq('transfer_id', tx.transfer_id));
        if (legs?.length !== 2) throw new ActionError({ code: 'BAD_REQUEST', message: 'La otra parte de esta transferencia está en una cuenta que no es tuya: pide a su titular que la elimine' });
        ok(await sb.from('transactions').delete().eq('transfer_id', tx.transfer_id), 'No se pudo eliminar');
      } else ok(await sb.from('transactions').delete().eq('id', id), 'No se pudo eliminar');
    },
  }),

  // Cuenta común: la titular invita por correo; la otra persona acepta desde /accounts.
  inviteMember: defineAction({
    accept: 'form',
    input: z.object({ account_id: id, email: z.email('Correo inválido').transform((v) => v.toLowerCase()), contribution_pct: pct, due_day: dueDay }),
    handler: async (input, ctx) => {
      ok(await db(ctx).from('account_members').insert(input), 'No se pudo invitar: la cuenta ya está compartida o el correo es el tuyo');
    },
  }),

  acceptInvite: defineAction({
    accept: 'form',
    input: z.object({ account_id: id }),
    handler: async ({ account_id }, ctx) => {
      ok(await db(ctx).from('account_members').update({ user_id: ctx.locals.userId }).eq('account_id', account_id).is('user_id', null));
    },
  }),

  setContribution: defineAction({
    accept: 'form',
    input: z.object({ account_id: id, contribution_pct: pct, due_day: dueDay }),
    handler: async ({ account_id, contribution_pct, due_day }, ctx) => {
      ok(await db(ctx).rpc('set_contribution', { p_account_id: account_id, p_pct: contribution_pct, p_due_day: due_day }));
    },
  }),

  // Rechazar la invitación, salir o dejar de compartir. Los movimientos se quedan en la cuenta de la titular.
  leaveShare: defineAction({
    accept: 'form',
    input: z.object({ account_id: id }),
    handler: async ({ account_id }, ctx) => {
      const sb = db(ctx);
      // Un depósito pendiente quedaría a medias: la pata de salida sin su pareja, imposible de confirmar.
      const pending = ok(await sb.from('transactions').select('id').eq('account_id', account_id).eq('status', 'pending').limit(1));
      if (pending?.length) throw new ActionError({ code: 'BAD_REQUEST', message: 'La cuenta tiene movimientos pendientes (por ejemplo un depósito sin confirmar): confírmenlos o descártenlos en la bandeja antes de dejar de compartirla' });
      ok(await sb.from('account_members').delete().eq('account_id', account_id));
    },
  }),

  dismissEvent: defineAction({
    accept: 'form',
    input: z.object({ id }),
    handler: async ({ id }, ctx) => {
      ok(await db(ctx).from('ingest_events').update({ status: 'ignored' }).eq('id', id));
    },
  }),

  rotateToken: defineAction({
    accept: 'form',
    handler: async (_, ctx) => {
      const sb = db(ctx);
      const token = randomBytes(32).toString('base64url');
      const token_hash = createHash('sha256').update(token).digest('hex');
      ok(await sb.from('ingest_tokens').upsert({ user_id: ctx.locals.userId, token_hash }));
      return { token }; // se muestra una sola vez
    },
  }),

  // Notificaciones push: el navegador guarda (o borra) su suscripción desde /settings y public/sw.js (JSON).
  savePushSubscription: defineAction({
    input: z.object({
      endpoint: z.url({ protocol: /^https$/ }).max(1000),
      keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
      device: z.string().trim().max(200).nullish(),
    }),
    handler: async ({ endpoint, keys, device }, ctx) => {
      ok(await db(ctx).from('push_subscriptions').upsert(
        { user_id: ctx.locals.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, ...(device ? { device } : {}) },
        { onConflict: 'user_id,endpoint' },
      ), 'No se pudo activar las notificaciones');
    },
  }),

  deletePushSubscription: defineAction({
    input: z.object({ endpoint: z.string().max(1000) }),
    handler: async ({ endpoint }, ctx) => {
      ok(await db(ctx).from('push_subscriptions').delete().eq('endpoint', endpoint), 'No se pudo desactivar las notificaciones');
    },
  }),

  // "enviar prueba" en /settings: a todos los dispositivos del usuario. Abre esta misma app (preview o producción).
  testPush: defineAction({
    accept: 'form',
    handler: async (_, ctx) => {
      const sb = db(ctx);
      if (!PUBLIC_VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        throw new ActionError({ code: 'BAD_REQUEST', message: 'Las notificaciones no están configuradas en el servidor' });
      }
      const subs = ok(await sb.from('push_subscriptions').select('id, endpoint, p256dh, auth'))!;
      if (!subs.length) throw new ActionError({ code: 'BAD_REQUEST', message: 'Activa las notificaciones en este dispositivo primero' });
      const r = await sendPush(subs, testNotice(ctx.url.origin), { publicKey: PUBLIC_VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: APP_URL });
      if (r.gone.length) ok(await sb.from('push_subscriptions').delete().in('id', r.gone));
      if (r.failed.length) noteError(new Error(`push: ${r.failed.join('; ')}`));
      if (!r.sent) throw new ActionError({ code: 'BAD_REQUEST', message: 'No se pudo enviar la prueba: vuelve a activar las notificaciones en este dispositivo' });
      return { sent: r.sent };
    },
  }),

  // Errores JS del navegador (Layout.astro los manda con fetch keepalive).
  logClientError: defineAction({
    input: z.object({ message: z.string().max(2000), stack: z.string().max(8000).nullish(), path: z.string().max(500), trail: z.unknown() }),
    handler: async ({ message, stack, path, trail }, ctx) => {
      await db(ctx).from('reports').insert({ kind: 'error', source: 'client', message: message || 'error', stack, path, context: { trail } });
    },
  }),

  sendReport: defineAction({
    accept: 'form',
    input: z.object({
      kind: z.enum(['bug', 'idea']),
      message: z.string().trim().min(3, 'Cuéntanos un poco más').max(2000),
      path: z.string().max(500).nullish(),
      client: z.string().max(2000).nullish(), // navegador, pantalla, idioma
      trail: z.string().max(20_000).nullish(),
    }),
    handler: async ({ kind, message, path, client, trail }, ctx) => {
      const sb = db(ctx);
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const [claims, errors, events] = await Promise.all([
        sb.auth.getClaims(),
        sb.from('reports').select('id, source, message, context, created_at').eq('kind', 'error').gte('created_at', since)
          .order('id', { ascending: false }).limit(10),
        // Solo id y error del parser: nunca `raw` ni montos (el issue es una copia fuera de la base).
        sb.from('ingest_events').select('id, source, status, error, received_at').in('status', ['new', 'review'])
          .order('id', { ascending: false }).limit(5),
      ]);
      let parsedTrail: unknown = null;
      try { parsedTrail = trail ? JSON.parse(trail) : null; } catch {}
      const sha = process.env.VERCEL_GIT_COMMIT_SHA;
      const deploy = process.env.VERCEL_URL;
      const report = ok(
        await sb.from('reports')
          .insert({ kind, source: 'user', message, path, context: { client, trail: parsedTrail, sha, deploy } })
          .select('id').single(),
        'No se pudo enviar el reporte',
      )!;

      const email = claims.data?.claims.email ?? ctx.locals.userId;
      const errs = (errors.data ?? []).map((e) => {
        const code = (e.context as { error?: { code?: string } } | null)?.error?.code;
        return `- #${e.id} ${e.created_at.slice(0, 16)} \`${e.source}\`${code ? ` ${code}` : ''}: ${e.message.slice(0, 200)}`;
      });
      const evs = (events.data ?? []).map((e) => `- evento ${e.id} (${e.source}, ${e.status}, ${e.received_at.slice(0, 16)})${e.error ? `: ${e.error}` : ''}`);
      const body = [
        message,
        '',
        `**De:** ${email} · **Página:** \`${path ?? '?'}\` · **Reporte:** #${report.id}`,
        `**Versión:** ${sha?.slice(0, 7) ?? 'local'}${deploy ? ` (${deploy})` : ''}`,
        `**Cliente:** ${client ?? '?'}`,
        '',
        '### Errores del usuario (24 h)',
        errs.length ? errs.join(NL) : '_ninguno_',
        '',
        '### Avisos sin procesar o en revisión',
        evs.length ? evs.join(NL) : '_ninguno_',
        '',
        '<details><summary>Rastro del navegador</summary>',
        '',
        '```json',
        JSON.stringify(parsedTrail, null, 1)?.slice(0, 30_000) ?? 'null',
        '```',
        '</details>',
        '',
        `Detalle completo: \`supabase db query --linked "select * from reports where user_id = '${ctx.locals.userId}' order by id desc limit 20"\``,
      ].join(NL);

      // Mismo token que dispara el parser (también tiene Issues: write). Si GitHub falla, el reporte ya está guardado.
      if (!GITHUB_DISPATCH_TOKEN) return { kind };
      try {
        const res = await fetch('https://api.github.com/repos/Alejololer/ez-finance-v2/issues', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
          body: JSON.stringify({
            title: `[${kind === 'bug' ? 'falla' : 'idea'}] ${message.split(NL)[0].slice(0, 80)}`,
            body,
            labels: ['piloto', kind],
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const { html_url } = await res.json();
        await sb.from('reports').update({ issue_url: html_url }).eq('id', report.id);
      } catch (err) {
        noteError(err, { report_id: report.id });
      }
      return { kind };
    },
  }),
};
