-- Cargos automáticos de tarjetas: desgravamen mensual (solo si hay deuda al corte) y costo anual.
-- scripts/reconcile.ts los propone como pendientes después de cada corte.
alter table public.accounts
  add column monthly_fee_cents integer check (monthly_fee_cents > 0),
  add column annual_fee_cents integer check (annual_fee_cents > 0),
  add column annual_fee_month smallint check (annual_fee_month between 1 and 12),
  -- Último corte ya procesado: si descartas un cargo en la bandeja, no se vuelve a crear.
  add column fees_through date;

create or replace view public.account_balances with (security_invoker = true) as
select a.id, a.user_id, a.name, a.type, a.currency, a.last4, a.is_default,
       coalesce(sum(t.amount_cents) filter (where t.status = 'confirmed'), 0)::bigint as balance_cents,
       a.statement_day, a.due_day, a.pay_from_account_id, a.interest_rate,
       a.monthly_fee_cents, a.annual_fee_cents, a.annual_fee_month
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
