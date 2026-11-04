-- Piloto cerrado: solo se registran los correos de esta lista (email o Google).
-- Agregar un piloto: insert into public.pilot_emails values ('correo@x.com');
create table public.pilot_emails (
  email text primary key check (email = lower(email))
);
-- Sin políticas para anon/authenticated: la API no la ve. Solo la lee Supabase Auth.
alter table public.pilot_emails enable row level security;
create policy pilot_emails_auth on public.pilot_emails for select to supabase_auth_admin using (true);

-- Hook "Before User Created" (activarlo en el dashboard: Auth → Hooks).
create function public.hook_before_user_created(event jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from public.pilot_emails where email = lower(event->'user'->>'email')) then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'El piloto es solo por invitación'))
  end
$$;

grant usage on schema public to supabase_auth_admin;
grant select on public.pilot_emails to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;
revoke all on public.pilot_emails from authenticated, anon;
