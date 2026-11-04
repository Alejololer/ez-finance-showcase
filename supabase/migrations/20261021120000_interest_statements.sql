-- Interés diario (Ahorro Flexible) y saldos de estados de cuenta. Ambos los procesa scripts/reconcile.ts.

-- % anual; null = la cuenta no genera interés.
alter table public.accounts
  add column interest_rate numeric(5,3) check (interest_rate > 0 and interest_rate < 100);

-- 'auto': filas que crea reconcile.ts (intereses y ajustes por estado de cuenta), no el usuario ni un aviso.
alter table public.transactions drop constraint transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('manual', 'email', 'android', 'ios', 'auto'));

-- Saldo de una cuenta a la fecha de corte según el banco. reconcile.ts ajusta la app a ese saldo.
create table public.statements (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id bigint not null,
  date date not null,
  balance_cents bigint not null,
  ingest_event_id bigint references public.ingest_events on delete set null,
  created_at timestamptz not null default now(),
  unique (account_id, date),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);
alter table public.statements enable row level security;
create policy own on public.statements for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace view public.account_balances with (security_invoker = true) as
select a.id, a.user_id, a.name, a.type, a.currency, a.last4, a.is_default,
       coalesce(sum(t.amount_cents) filter (where t.status = 'confirmed'), 0)::bigint as balance_cents,
       a.statement_day, a.due_day, a.pay_from_account_id, a.interest_rate
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
