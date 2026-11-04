-- Desgravamen por tramos de deuda (PacifiCard: hasta $35,000 → $5, hasta $50,000 → $6.50, hasta $80,000 → $7).
-- [{ "upto": cents | null, "cents": cents }, …] ordenado por tope; null = monto fijo. Lo valida updateAccount.
-- Reemplaza monthly_fee_cents (sin datos aún); quitar una columna de la vista obliga a recrearla.
drop view public.account_balances;
alter table public.accounts
  drop column monthly_fee_cents,
  add column monthly_fee_tiers jsonb check (jsonb_typeof(monthly_fee_tiers) = 'array');

create view public.account_balances with (security_invoker = true) as
select a.id, a.user_id, a.name, a.type, a.currency, a.last4, a.is_default,
       coalesce(sum(t.amount_cents) filter (where t.status = 'confirmed'), 0)::bigint as balance_cents,
       a.statement_day, a.due_day, a.pay_from_account_id, a.interest_rate,
       a.annual_fee_cents, a.annual_fee_month, a.monthly_fee_tiers
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
