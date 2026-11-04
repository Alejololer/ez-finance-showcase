-- ez-finance v2: esquema inicial.
-- Montos en cents con signo (negativo = sale dinero). Saldos derivados, nunca guardados.
-- Ownership: cada tabla tiene user_id + FKs compuestas (id, user_id) para que una
-- transacción no pueda apuntar a la cuenta/categoría de otro usuario, ni siquiera con service role.

create table public.accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 60),
  type text not null check (type in ('checking', 'savings', 'credit', 'cash')),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  last4 text check (last4 ~ '^\d{4}$'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index accounts_one_default on public.accounts (user_id) where is_default;

create table public.categories (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 40),
  color text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

-- Texto crudo recibido de email / notificación / atajo. Lo procesa scripts/parse-pending.ts.
create table public.ingest_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  source text not null check (source in ('email', 'android', 'ios')),
  raw text not null check (length(raw) between 1 and 16000),
  raw_hash text not null,
  received_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'parsed', 'ignored', 'review')),
  parsed jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique (user_id, raw_hash)
);
create index ingest_events_new on public.ingest_events (id) where status = 'new';

create table public.transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id bigint not null,
  category_id bigint,
  amount_cents bigint not null check (amount_cents <> 0),
  date date not null,
  merchant text check (length(merchant) <= 120),
  description text check (length(description) <= 500),
  kind text not null check (kind in ('expense', 'income', 'transfer')),
  transfer_id uuid,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed')),
  source text not null default 'manual' check (source in ('manual', 'email', 'android', 'ios')),
  ingest_event_id bigint references public.ingest_events on delete set null,
  duplicate_of bigint references public.transactions on delete set null,
  created_at timestamptz not null default now(),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete restrict,
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete set null (category_id)
);
create index transactions_user_date on public.transactions (user_id, date desc);

-- Una por usuario; regenerar reemplaza el hash. El token en claro nunca se guarda.
create table public.ingest_tokens (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

create view public.account_balances with (security_invoker = true) as
select a.id, a.user_id, a.name, a.type, a.currency, a.last4, a.is_default,
       coalesce(sum(t.amount_cents) filter (where t.status = 'confirmed'), 0)::bigint as balance_cents
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;

-- RLS: cada usuario solo ve y toca lo suyo. ingest_events lo inserta /api/ingest con service role.
alter table public.accounts enable row level security;
alter table public.categories enable row level security;
alter table public.ingest_events enable row level security;
alter table public.transactions enable row level security;
alter table public.ingest_tokens enable row level security;

create policy own on public.accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.categories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.ingest_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.ingest_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Usuario nuevo: cuenta por defecto + categorías base, así el parser siempre tiene dónde asignar.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (user_id, name, type, is_default)
  values (new.id, 'Cuenta principal', 'checking', true);
  insert into public.categories (user_id, name, color)
  select new.id, c.name, c.color from (values
    ('Comida', '#f97316'), ('Supermercado', '#22c55e'), ('Transporte', '#3b82f6'),
    ('Servicios', '#eab308'), ('Vivienda', '#8b5cf6'), ('Salud', '#ef4444'),
    ('Entretenimiento', '#ec4899'), ('Compras', '#14b8a6'), ('Suscripciones', '#6366f1'),
    ('Otros', '#64748b')
  ) as c(name, color);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
