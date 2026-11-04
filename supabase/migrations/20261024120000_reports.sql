-- Errores capturados solos (server, client, parser) y reportes de los usuarios (bug, idea) del piloto.
-- user_id null = error sin sesión (login): lo inserta la service role desde src/lib/report.ts.
create table public.reports (
  id bigint generated always as identity primary key,
  user_id uuid default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('error', 'bug', 'idea')),
  source text not null check (source in ('server', 'client', 'parser', 'user')),
  message text not null check (length(message) between 1 and 2000),
  stack text check (length(stack) <= 8000),
  path text check (length(path) <= 500),
  context jsonb,
  issue_url text,
  created_at timestamptz not null default now()
);
create index reports_user_created on public.reports (user_id, created_at desc);

alter table public.reports enable row level security;
create policy own_insert on public.reports for insert to authenticated with check (user_id = (select auth.uid()));
create policy own_select on public.reports for select to authenticated using (user_id = (select auth.uid()));
create policy own_update on public.reports for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
