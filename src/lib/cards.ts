// Estado de las tarjetas de crédito del usuario (lo usan inicio y /accounts).
import type { SupabaseClient } from '@supabase/supabase-js';
import { cardStatus, cycle, type CardStatus, type Cycle } from './card';
import { today } from './money';

type Acc = { id: number; name: string; type: string; is_default: boolean; statement_day: number | null; due_day: number | null; pay_from_account_id: number | null };
// `bank`: lo facturado según el banco al último corte (fila de `statements`), si lo anotaste; `appStatement`: lo que
// calcula la app con sus movimientos (puede incluir compras que el banco aún no factura).
export type CardSummary = { cycle: Cycle; status: CardStatus; payFromId: number | null; bank: number | null; appStatement: number };

export async function cardSummaries(sb: SupabaseClient, accounts: Acc[]) {
  const cards = accounts.filter((a) => a.type === 'credit' && a.statement_day && a.due_day);
  const out = new Map<number, CardSummary>();
  if (!cards.length) return out;
  const ids = cards.map((c) => c.id);
  const [{ data }, { data: statements }] = await Promise.all([
    sb.from('transactions').select('account_id, date, amount_cents, kind').eq('status', 'confirmed').in('account_id', ids),
    sb.from('statements').select('account_id, date, balance_cents, due_date').in('account_id', ids),
  ]);
  const now = today();
  const fallback = accounts.find((a) => a.is_default)?.id ?? null;
  for (const card of cards) {
    let c = cycle(card.statement_day!, card.due_day!, now);
    const txs = (data ?? []).filter((t) => t.account_id === card.id);
    const st = statements?.find((s) => s.account_id === card.id && s.date === c.lastClose);
    // La fecha máxima del estado de cuenta manda sobre el día de pago configurado: el banco la puede mover.
    if (st?.due_date) c = { ...c, dueDate: st.due_date };
    const bank = st ? Math.max(0, -st.balance_cents) : null;
    const payFromId = card.pay_from_account_id ?? (fallback !== card.id ? fallback : null);
    const appStatement = cardStatus(txs, c, now).statement;
    out.set(card.id, { cycle: c, status: cardStatus(txs, c, now, bank ?? undefined), payFromId, bank, appStatement });
  }
  return out;
}

export const shortDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' });
