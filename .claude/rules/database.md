---
paths:
  - "supabase/**"
  - "src/actions/**"
  - "src/lib/supabase.ts"
---

# Base de datos (Supabase `your-project-ref`)

- **Migraciones**: `supabase/migrations/YYYYMMDDHHMMSS_desc.sql` con timestamp completo (dos el mismo día
  sin hora colisionan en el tracker). Flujo: `supabase db push --dry-run` → revisar → `supabase db push --yes`.
  Aplica en producción al instante: aplicar la migración **antes** de desplegar código que la necesite.
- **Ownership**: toda tabla tiene `user_id` + RLS `user_id = (select auth.uid())`. Las FKs a cuentas y
  categorías son compuestas `(id, user_id)`: la DB impide cruzar datos entre usuarios incluso con service role.
- La service role (`adminClient()`) solo se usa en `/api/ingest`, en `scripts/` y en `flush()` de
  `src/lib/report.ts` para errores **sin sesión** (`user_id null`). Todo lo demás pasa por el cliente del usuario (RLS).
- `reports`: errores (`kind 'error'`, `source` server|client|parser) y reportes del usuario (`bug`|`idea`, con
  `issue_url`). En el servidor, `noteError()` (síncrona, la llama `ok()`) anota y el middleware guarda al final de
  la request. El error completo de Postgres (`details` puede traer valores) se queda aquí; al issue solo id/código/mensaje.
- Montos en cents `bigint` **con signo** (gasto negativo). Saldos nunca se guardan: vista `account_balances`.
- Una transferencia son dos filas con el mismo `transfer_id` (salida negativa, entrada positiva); insertarlas
  en un solo `insert([...])` para que sea atómico.
- Cambios a un `check` existente: `drop constraint <tabla>_<col>_check` + `add constraint` (consultar el nombre
  con `supabase db query --linked "select conname from pg_constraint where conrelid='public.<tabla>'::regclass"`).
- **Piloto cerrado**: el hook `hook_before_user_created` (activado en el dashboard, Auth → Hooks) rechaza todo
  correo fuera de `pilot_emails` (email y Google). Invitar = `insert into public.pilot_emails values ('x@y.com')`.
  Los usuarios temporales de prueba también: insertar su correo antes de crearlos y borrarlo al final.
- Usuario nuevo: el trigger `handle_new_user` crea "Cuenta principal" (por defecto) y 10 categorías.
- Tarjetas (`type = 'credit'`): saldo negativo = deuda; `statement_day`/`due_day` (1-31, recortados a fin de mes)
  y `pay_from_account_id` (null = cuenta por defecto). La vista `account_balances` expone esas columnas al final
  (`create or replace view` solo permite agregar columnas al final).
- `accounts.interest_rate` (% anual, null = sin interés) y tabla `statements` (saldo del banco al corte, único por
  cuenta y fecha; en tarjetas, `balance_cents` = −pago de contado del corte, no el saldo, y `due_date` = fecha máxima de pago
  del estado, que manda sobre `due_day` en `cards.ts`; null si el monto se anotó a mano). Filas creadas por
  `scripts/reconcile.ts` llevan `source = 'auto'`.
- Cargos de tarjetas: `monthly_fee_tiers` jsonb (desgravamen por tramos de deuda `[{upto, cents}]`, `upto` null =
  fijo; solo con deuda al corte; formato/validación en `parseTiers()` de `card.ts`), `annual_fee_cents` +
  `annual_fee_month`, y `fees_through` (último corte procesado; lápida para no recrear cargos descartados).
- **Cuenta común** (`account_members`, una fila por cuenta compartida, una sola persona más): la titular invita
  (`email`, `contribution_pct`; `owner_id`/`owner_email` salen de la sesión por grants de columna) y la invitada
  acepta poniendo `user_id` (solo ella puede: si la titular pudiera, vería los ingresos de cualquiera). Policies
  `shared` **aditivas** en `accounts` (select), `transactions` (todo) y `categories` (select de la titular), con
  subconsulta a `account_members`; las de `account_members` solo comparan columnas (evita recursión de RLS). Las
  filas de la cuenta común siguen con el `user_id` de la titular y sus categorías (FK compuesta): en las actions lo
  resuelve `place()`, en el parser `place()`/`ownerOf()`. `shared_split()` (ingreso y gasto común por persona y
  mes, 3 meses), `shared_deposits()` (quién depositó cada aporte) y `set_contribution()` (% y `due_day`) son
  `security definer` (excepción deliberada a "lógica fuera de la DB"): solo datos; el ciclo del aporte está en
  `contribution()` de `src/lib/split.ts` (vence el día `due_day`, % del ingreso del mes anterior, lo que falte se
  arrastra un ciclo y queda vencido). Probado con tres usuarios temporales (titular, pareja, ajena) con clientes logueados.
- Fechas "de hoy" con `today()` de `src/lib/money.ts` (hora de Ecuador), nunca `toISOString().slice(0, 10)`
  (UTC: desde las 19:00 locales ya es mañana).
- **Forms de Astro**: los campos ausentes llegan como `null`, no `undefined` → en zod usar `.nullish()`, nunca `.optional()`.
- Los previews de Vercel usan la **misma base de producción**: probar con usuarios temporales y borrarlos.
