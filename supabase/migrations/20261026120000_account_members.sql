-- Cuenta común ("cuenta mixta"): la titular comparte una cuenta suya con otra persona que también usa la app.
-- Las dos ven y registran los movimientos de esa cuenta; de lo demás, cada una ve solo el total de ingresos de la otra
-- (shared_split). Las filas de la cuenta común siguen con el user_id de la titular (FK compuesta de transactions).
create table public.account_members (
  account_id bigint primary key, -- una sola persona más por cuenta
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  owner_email text not null default lower(auth.jwt() ->> 'email'),
  email text not null check (email = lower(email)), -- invitada
  user_id uuid references auth.users on delete cascade, -- null = invitación sin aceptar
  contribution_pct numeric(5,2) not null check (contribution_pct > 0 and contribution_pct <= 100),
  created_at timestamptz not null default now(),
  check (email <> owner_email),
  foreign key (account_id, owner_id) references public.accounts (id, user_id) on delete cascade
);

-- Las políticas solo comparan columnas (nada de subconsultas a accounts): las de accounts/transactions consultan esta
-- tabla y una referencia de vuelta sería recursión de RLS.
alter table public.account_members enable row level security;
create policy owner_read on public.account_members for select to authenticated
  using (owner_id = (select auth.uid()));
create policy owner_insert on public.account_members for insert to authenticated
  with check (owner_id = (select auth.uid()) and user_id is null);
create policy owner_delete on public.account_members for delete to authenticated
  using (owner_id = (select auth.uid()));
create policy invitee_read on public.account_members for select to authenticated
  using (email = lower((select auth.jwt()) ->> 'email'));
-- Aceptar = la invitada se pone a sí misma. Nadie más puede escribir user_id: si la titular pudiera, vería los
-- ingresos de quien quisiera.
create policy invitee_accept on public.account_members for update to authenticated
  using (email = lower((select auth.jwt()) ->> 'email'))
  with check (email = lower((select auth.jwt()) ->> 'email') and user_id = (select auth.uid()));
create policy invitee_delete on public.account_members for delete to authenticated
  using (email = lower((select auth.jwt()) ->> 'email'));
-- Columnas: owner_id/owner_email salen siempre de la sesión; solo la invitada actualiza (user_id). El % lo cambia
-- cualquiera de las dos con set_contribution_pct().
revoke insert, update on public.account_members from authenticated, anon;
grant insert (account_id, email, contribution_pct) on public.account_members to authenticated;
grant update (user_id) on public.account_members to authenticated;

-- Se suman (OR) a las políticas `own`, que no cambian.
create policy shared on public.accounts for select to authenticated
  using (id in (select account_id from public.account_members where user_id = (select auth.uid())));
create policy shared on public.transactions for all to authenticated
  using (account_id in (select account_id from public.account_members where user_id = (select auth.uid())))
  with check (account_id in (select account_id from public.account_members where user_id = (select auth.uid())));
-- Para mostrar la categoría de los movimientos comunes (son de la titular).
create policy shared on public.categories for select to authenticated
  using (user_id in (select owner_id from public.account_members where user_id = (select auth.uid())));

create function public.set_contribution_pct(p_account_id bigint, p_pct numeric) returns void
language sql security definer set search_path = '' as $$
  update public.account_members set contribution_pct = p_pct
  where account_id = p_account_id and (select auth.uid()) in (owner_id, user_id)
$$;

-- Totales por persona y mes (anterior y actual, hora de Ecuador) de cada cuenta común aceptada de la sesión.
-- security definer porque cada persona no puede leer las filas de la otra: solo sumas, el reparto se hace en
-- src/lib/split.ts. Excepción deliberada a "lógica fuera de la DB".
-- ponytail: ingreso del mes calendario; un mes con dos sueldos (pago adelantado) descuadra ese mes. Promedio de 2-3
-- meses si molesta.
create function public.shared_split()
returns table (account_id bigint, user_id uuid, email text, month date, income_cents bigint,
               deposited_cents bigint, expense_cents bigint, contribution_pct numeric)
language sql stable security definer set search_path = '' as $$
  with m as (
    select * from public.account_members m
    where m.user_id is not null and (select auth.uid()) in (m.owner_id, m.user_id)
  ), people as (
    select m.account_id, m.owner_id as user_id, m.owner_email as email, m.contribution_pct from m
    union all
    select m.account_id, m.user_id, m.email, m.contribution_pct from m
  ), months as (
    select date_trunc('month', d)::date as month
    from (values ((now() at time zone 'America/Guayaquil')::date),
                 ((now() at time zone 'America/Guayaquil')::date - interval '1 month')) v(d)
  )
  select p.account_id, p.user_id, p.email, mo.month,
    -- Ingresos de la persona fuera de la cuenta común; sin intereses (reconcile.ts los guarda como 'auto').
    (select coalesce(sum(t.amount_cents), 0)::bigint from public.transactions t
      where t.user_id = p.user_id and t.account_id <> p.account_id and t.kind = 'income'
        and t.status = 'confirmed' and t.source <> 'auto'
        and t.date >= mo.month and t.date < mo.month + interval '1 month'),
    -- Depósitos: patas de entrada en la cuenta común cuya salida es una cuenta de la persona.
    (select coalesce(sum(i.amount_cents), 0)::bigint from public.transactions i
      join public.transactions o on o.transfer_id = i.transfer_id and o.amount_cents < 0
      where i.account_id = p.account_id and i.kind = 'transfer' and i.amount_cents > 0 and i.status = 'confirmed'
        and o.user_id = p.user_id and o.account_id <> p.account_id
        and i.date >= mo.month and i.date < mo.month + interval '1 month'),
    (select coalesce(-sum(t.amount_cents), 0)::bigint from public.transactions t
      where t.account_id = p.account_id and t.kind = 'expense' and t.status = 'confirmed'
        and t.date >= mo.month and t.date < mo.month + interval '1 month'),
    p.contribution_pct
  from people p cross join months mo
  order by p.account_id, mo.month, p.user_id = (select auth.uid()) desc
$$;

revoke execute on function public.set_contribution_pct(bigint, numeric) from public, anon;
revoke execute on function public.shared_split() from public, anon;
grant execute on function public.set_contribution_pct(bigint, numeric) to authenticated;
grant execute on function public.shared_split() to authenticated;
