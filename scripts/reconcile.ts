// Intereses diarios, cargos de tarjetas y ajustes por estado de cuenta. Corre en el Action después del parser (sin Claude).
// Idempotente: se puede correr cada hora. No loguear montos.
import { createClient } from '@supabase/supabase-js';
import { cardFees, cycle } from '../src/lib/card.ts';
import { addDays, interestRows } from '../src/lib/interest.ts';
import { formatMoney, today as localToday } from '../src/lib/money.ts';
import { cutoffDiff, MAX_AUTO } from '../src/lib/statement.ts';

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { persistSession: false },
});
const ok = <T>(r: { data: T; error: unknown }) => {
  if (r.error) throw r.error;
  return r.data;
};
const list = <T>(r: { data: T[] | null; error: unknown }) => ok(r) ?? [];

const today = localToday();
const yesterday = addDays(today, -1);

// Saldo confirmado de la cuenta al cierre de `date` (la vista no tiene fecha: total menos lo posterior).
async function balanceAt(accountId: number, date: string) {
  const total = ok(await db.from('account_balances').select('balance_cents').eq('id', accountId).single())!;
  const after = list(await db.from('transactions').select('amount_cents').eq('account_id', accountId).eq('status', 'confirmed').gt('date', date));
  return total.balance_cents - after.reduce((s, t) => s + t.amount_cents, 0);
}

// 1. Interés: una fila por día, desde el día siguiente al último interés registrado. La primera vez, desde el primer
// movimiento de la cuenta: si el cron se atrasa y pasa la medianoche, ese día no se pierde.
// ponytail: lo ya generado no se recalcula si después cambia un saldo pasado; el estado de cuenta corrige los centavos.
const savers = list(await db.from('accounts').select('id, user_id, interest_rate').not('interest_rate', 'is', null));
for (const a of savers) {
  const last = ok(await db.from('transactions').select('date').eq('account_id', a.id).eq('source', 'auto')
    .like('reference', 'INT-%').order('date', { ascending: false }).limit(1).maybeSingle());
  const first = last ? null : ok(await db.from('transactions').select('date').eq('account_id', a.id).eq('status', 'confirmed')
    .order('date').limit(1).maybeSingle());
  let from = last ? addDays(last.date, 1) : (first?.date ?? yesterday);
  if (from < addDays(yesterday, -45)) from = addDays(yesterday, -45);
  if (from > yesterday) continue;
  const txs = list(await db.from('transactions').select('date, amount_cents').eq('account_id', a.id).eq('status', 'confirmed')
    .gte('date', from).lte('date', yesterday));
  const rows = interestRows(await balanceAt(a.id, addDays(from, -1)), txs, Number(a.interest_rate), from, yesterday);
  if (rows.length) {
    ok(await db.from('transactions').insert(rows.map((r) => ({
      user_id: a.user_id, account_id: a.id, amount_cents: r.cents, date: r.date, kind: 'income', status: 'confirmed',
      source: 'auto', merchant: 'Intereses', reference: `INT-${r.date.replaceAll('-', '')}`,
    }))));
  }
  console.log(`account ${a.id}: ${rows.length} interest rows`);
}

// 2. Cargos de tarjetas (desgravamen, costo anual): uno por corte, como pendiente para que lo confirmes en la bandeja.
// `fees_through` marca el último corte procesado, así un cargo descartado no se vuelve a crear. La primera vez solo
// se marca: los cortes anteriores ya están en el saldo que ajustaste.
const cards = list(await db.from('accounts')
  .select('id, user_id, statement_day, due_day, monthly_fee_tiers, annual_fee_cents, annual_fee_month, fees_through')
  .eq('type', 'credit').not('statement_day', 'is', null).not('due_day', 'is', null)
  .or('monthly_fee_tiers.not.is.null,annual_fee_cents.not.is.null'));
for (const c of cards) {
  const close = cycle(c.statement_day!, c.due_day!, yesterday).lastClose; // el día del corte ya terminó
  if (c.fees_through && close <= c.fees_through) continue;
  const fees = c.fees_through ? cardFees(c, close, await balanceAt(c.id, close)) : [];
  if (fees.length) {
    ok(await db.from('transactions').insert(fees.map((f) => ({
      user_id: c.user_id, account_id: c.id, amount_cents: -f.cents, date: close, kind: 'expense', status: 'pending',
      source: 'auto', merchant: f.merchant, reference: f.reference,
    }))));
  }
  ok(await db.from('accounts').update({ fees_through: close }).eq('id', c.id));
  console.log(`card ${c.id}: ${fees.length} fees`);
}

// 3. Estados de cuenta: el saldo de la app al corte se lleva al del banco con un ajuste que se recalcula en cada
// corrida (si después confirmas algo anterior al corte, el ajuste se achica). Diferencias grandes no se tocan:
// casi seguro falta registrar un movimiento, así que el aviso vuelve a la bandeja para que lo revises.
const statements = list(await db.from('statements')
  .select('id, user_id, account_id, date, balance_cents, ingest_event_id, event:ingest_events(status), account:accounts(name, currency, type)')
  .gte('date', addDays(today, -90)).order('date'));
for (const s of statements) {
  const event = s.event as unknown as { status: string } | null;
  const account = s.account as unknown as { name: string; currency: string; type: string };
  if (event?.status === 'ignored') continue; // lo descartaste en la bandeja
  // En tarjetas la fila es lo facturado al corte (sin compras en tránsito), no el saldo: solo la usa cards.ts.
  if (account.type === 'credit') continue;
  // Un corte anterior al primer movimiento volvería a sumar el saldo inicial cargado con "ajustar saldo".
  const first = ok(await db.from('transactions').select('date').eq('account_id', s.account_id).order('date').limit(1).maybeSingle());
  if (!first || s.date < first.date) continue;
  const pending = ok(await db.from('transactions').select('id').eq('account_id', s.account_id).eq('status', 'pending')
    .lte('date', s.date).limit(1).maybeSingle());
  if (pending) continue; // espera a que confirmes o descartes lo de la bandeja

  const reference = `EDC-${s.id}`;
  const own = ok(await db.from('transactions').select('id, amount_cents').eq('account_id', s.account_id).eq('reference', reference).maybeSingle());
  const app = (await balanceAt(s.account_id, s.date)) - (own?.amount_cents ?? 0);
  // Movimientos reales (no ajustes) del corte y del día siguiente, por si el banco cortó antes o después de medianoche.
  const edge = list(await db.from('transactions').select('date, amount_cents').eq('account_id', s.account_id)
    .eq('status', 'confirmed').neq('kind', 'adjustment').in('date', [s.date, addDays(s.date, 1)]));
  const on = (d: string) => edge.filter((t) => t.date === d).map((t) => t.amount_cents);
  const diff = cutoffDiff(s.balance_cents - app, on(s.date), on(addDays(s.date, 1)));

  if (Math.abs(diff) > MAX_AUTO) {
    if (s.ingest_event_id && event?.status !== 'review') {
      ok(await db.from('ingest_events').update({
        status: 'review',
        error: `Estado de cuenta de ${account.name} al ${s.date.split('-').reverse().join('-')}: el banco tiene ${formatMoney(Math.abs(diff), account.currency)} ${diff > 0 ? 'más' : 'menos'} que la app. ${diff > 0 ? 'Puede faltar un ingreso o sobrar un gasto' : 'Puede faltar un gasto o sobrar un ingreso'}. Si el saldo de hoy coincide con el del banco, descarta este aviso.`,
      }).eq('id', s.ingest_event_id));
    }
    console.log(`statement ${s.id}: review`);
    continue;
  }
  if (event?.status === 'review') ok(await db.from('ingest_events').update({ status: 'parsed', error: null }).eq('id', s.ingest_event_id!));
  if (own && diff === 0) ok(await db.from('transactions').delete().eq('id', own.id));
  else if (own && own.amount_cents !== diff) ok(await db.from('transactions').update({ amount_cents: diff }).eq('id', own.id));
  else if (!own && diff !== 0) {
    ok(await db.from('transactions').insert({
      user_id: s.user_id, account_id: s.account_id, amount_cents: diff, date: s.date, kind: 'adjustment', status: 'confirmed',
      source: 'auto', description: 'Ajuste por estado de cuenta', reference,
    }));
  }
  console.log(`statement ${s.id}: reconciled`);
}
