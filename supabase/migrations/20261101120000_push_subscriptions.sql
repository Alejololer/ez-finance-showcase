-- Notificaciones push web (Android y iPhone con la app en la pantalla de inicio). Una fila por navegador/dispositivo
-- suscrito. La guarda el navegador (action savePushSubscription, RLS); la lee scripts/parse-pending.ts con service
-- role para avisar de lo nuevo en la bandeja. Las suscripciones vencidas (404/410 del servicio push) se borran al enviar.
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) between 1 and 200),
  auth text not null check (length(auth) between 1 and 100),
  device text check (length(device) <= 200),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

alter table public.push_subscriptions enable row level security;
create policy own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
