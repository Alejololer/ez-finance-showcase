-- Aporte mensual con fecha límite (como el pago de la tarjeta): el aporte que vence el día `due_day` es el % del
-- ingreso del mes anterior. El ciclo se arma en src/lib/split.ts; aquí solo los datos.
alter table public.account_members
  add column due_day smallint not null default 5 check (due_day between 1 and 31);
grant insert (due_day) on public.account_members to authenticated;

drop function public.set_contribution_pct(bigint, numeric);
create function public.set_contribution(p_account_id bigint, p_pct numeric, p_due_day smallint) returns void
language sql security definer set search_path = '' as $$
  update public.account_members set contribution_pct = p_pct, due_day = p_due_day
  where account_id = p_account_id and (select auth.uid()) in (owner_id, user_id)
$$;

-- Ingreso y gasto común por persona y mes calendario (actual y dos anteriores: el aporte vigente y el anterior se
-- calculan con el ingreso del mes previo a cada vencimiento). Ver la migración anterior para el porqué del definer.
drop function public.shared_split();
create function public.shared_split()
returns table (account_id bigint, user_id uuid, email text, month date, income_cents bigint, expense_cents bigint,
               contribution_pct numeric, due_day smallint, since date)
language sql stable security definer set search_path = '' as $$
  with m as (
    select * from public.account_members m
    where m.user_id is not null and (select auth.uid()) in (m.owner_id, m.user_id)
  ), people as (
    select m.account_id, m.owner_id as user_id, m.owner_email as email, m.contribution_pct, m.due_day, m.created_at from m
    union all
    select m.account_id, m.user_id, m.email, m.contribution_pct, m.due_day, m.created_at from m
  ), months as (
    select (date_trunc('month', (now() at time zone 'America/Guayaquil')::date) - make_interval(months => k))::date as month
    from generate_series(0, 2) k
  )
  select p.account_id, p.user_id, p.email, mo.month,
    -- Ingresos de la persona fuera de la cuenta común; sin intereses (reconcile.ts los guarda como 'auto').
    (select coalesce(sum(t.amount_cents), 0)::bigint from public.transactions t
      where t.user_id = p.user_id and t.account_id <> p.account_id and t.kind = 'income'
        and t.status = 'confirmed' and t.source <> 'auto'
        and t.date >= mo.month and t.date < mo.month + interval '1 month'),
    (select coalesce(-sum(t.amount_cents), 0)::bigint from public.transactions t
      where t.account_id = p.account_id and t.kind = 'expense' and t.status = 'confirmed'
        and t.date >= mo.month and t.date < mo.month + interval '1 month'),
    p.contribution_pct, p.due_day, (p.created_at at time zone 'America/Guayaquil')::date
  from people p cross join months mo
  order by p.account_id, mo.month, p.user_id = (select auth.uid()) desc
$$;

-- Depósitos confirmados de cada persona a la cuenta común (últimos ~3 meses): patas de entrada cuya salida es una
-- cuenta de esa persona. Las patas de entrada ya las ven las dos; esto agrega quién depositó.
create function public.shared_deposits()
returns table (account_id bigint, user_id uuid, date date, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  select i.account_id, o.user_id, i.date, i.amount_cents
  from public.account_members m
  join public.transactions i on i.account_id = m.account_id
  join public.transactions o on o.transfer_id = i.transfer_id and o.amount_cents < 0 and o.account_id <> m.account_id
  where m.user_id is not null and (select auth.uid()) in (m.owner_id, m.user_id)
    and o.user_id in (m.owner_id, m.user_id)
    and i.kind = 'transfer' and i.amount_cents > 0 and i.status = 'confirmed'
    and i.date >= (now() at time zone 'America/Guayaquil')::date - 100
$$;

revoke execute on function public.set_contribution(bigint, numeric, smallint) from public, anon;
revoke execute on function public.shared_split() from public, anon;
revoke execute on function public.shared_deposits() from public, anon;
grant execute on function public.set_contribution(bigint, numeric, smallint) to authenticated;
grant execute on function public.shared_split() to authenticated;
grant execute on function public.shared_deposits() to authenticated;
