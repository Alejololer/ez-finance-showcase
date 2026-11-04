-- Tarjetas de crédito: ciclo de facturación y cuenta desde la que se pagan.
-- Números de 3 o 4 dígitos: PacifiCard enmascara la tarjeta como 542258XXXXXXX458 (solo 3 al final).
alter table public.accounts drop constraint accounts_last4_check;
alter table public.accounts add constraint accounts_last4_check check (last4 ~ '^\d{3,4}(,\d{3,4}){0,9}$');

alter table public.accounts
  add column statement_day smallint check (statement_day between 1 and 31), -- día de corte (se recorta a fin de mes)
  add column due_day smallint check (due_day between 1 and 31),             -- día límite de pago
  add column pay_from_account_id bigint,                                     -- null = cuenta por defecto
  add constraint accounts_pay_from_fk foreign key (pay_from_account_id, user_id)
    references public.accounts (id, user_id) on delete set null (pay_from_account_id),
  add constraint accounts_pay_from_not_self check (pay_from_account_id is distinct from id);

-- Mismas columnas al inicio; las nuevas al final (create or replace solo permite agregar al final).
create or replace view public.account_balances with (security_invoker = true) as
select a.id, a.user_id, a.name, a.type, a.currency, a.last4, a.is_default,
       coalesce(sum(t.amount_cents) filter (where t.status = 'confirmed'), 0)::bigint as balance_cents,
       a.statement_day, a.due_day, a.pay_from_account_id
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
