# ez-finance

Finanzas personales con captura automática de gastos: los avisos del banco (correo, notificación, SMS) llegan
solos, Claude los interpreta y el usuario solo confirma en la bandeja. Uso personal (USD, Banco Pichincha).

Astro 7 SSR en Vercel + Supabase + Claude Code headless (GitHub Actions) como parser.
Reemplaza al v1 en Next.js (repo `Alejololer/ez-finance`, archivado; no reutilizar su código).

| Recurso | Dónde |
|---|---|
| Repo | `Alejololer/ez-finance-v2` (privado) |
| Producción | https://ez-finance.example.com (cada push a `main` despliega) |
| Supabase | proyecto `ez-finance`, ref `your-project-ref` (CLI ya linkeado) |
| Parser | workflow `parse-pending` (`.github/workflows/parse.yml`) |
| Reportes | botón "reportar" → issues `gh issue list -l piloto`; errores sin reporte: tabla `reports` (`supabase db query --linked`) |

```bash
npm run dev      # localhost:4321 (requiere .env, ver .env.example)
npm test         # vitest
npm run check    # astro check (tipos)
npm run build
```

## Flujo

```
Gmail (Apps Script) / Android (MacroDroid) / iOS (Atajos)
  → POST /api/ingest (Bearer token por usuario) → ingest_events (crudo, dedup por hash)
  → /api/ingest dispara el workflow (GITHUB_DISPATCH_TOKEN; cron horario de respaldo)
  → GitHub Action parse-pending: claude -p --json-schema (+ comercios ya categorizados) → decide() → transactions 'pending'
  → push web (VAPID, src/lib/push.ts + public/sw.js) a cada dispositivo suscrito: "N nuevos en la bandeja"
  → /inbox: el usuario confirma, corrige o descarta
  (estados de cuenta: sin Claude → statements; luego scripts/reconcile.ts: interés diario + ajuste al corte;
   tarjetas: pago de contado del banco + cada línea del PDF cruzada con lo registrado, lo que falte → pendiente)
```

Modelo: `accounts` (dinero real, `last4` = últimos 3-4 dígitos de la cuenta y sus tarjetas "7105,5518,458";
tarjetas `credit` con `statement_day`/`due_day` y `pay_from_account_id` — ciclo en `src/lib/card.ts`), `categories`, `transactions`
(`amount_cents bigint` con signo: gasto negativo; `kind` expense|income|transfer|adjustment; `status`
pending|confirmed), `ingest_events` (texto crudo), `ingest_tokens` (hash del token de captura).
Saldo = vista `account_balances` (solo `confirmed`). Ajustes de saldo no cuentan como gasto ni ingreso.
Cuenta común (`account_members`): la titular comparte una cuenta con otra persona de la app; cada una pone el mismo
% de su ingreso del mes (`shared_split()` + `src/lib/split.ts`, bloque "aporte" en inicio). Detalle en `database.md`.

## Archivos clave

- `src/lib/parse.ts` (+ test) — prompt, JSON schema y `decide()`. Puro, sin deps de Astro.
- `scripts/parse-pending.ts` — lo corre el Action; Node 24 ejecuta TS directo.
- `src/pages/api/ingest.ts` — único uso de `adminClient()` en la app (salta RLS; el user_id sale del token).
- `src/actions/index.ts` — todas las mutaciones (Astro Actions con forms sin JS). Cada handler valida sesión con `db(ctx)` y respuestas con `ok()`.
- `src/components/TxFields.astro`, `TransferFields.astro` — campos compartidos; `Confirm.astro` — confirmación de destructivos (popover).
- `src/layouts/Layout.astro` (nav, lente, atajos 0-4, vapor, `ClientRouter`: se navega sin recargar) y `src/components/Sculpture.astro` (escultura 1-bit WebGL de fondo, persiste entre páginas) — identidad "statue hall", detalle en `.claude/rules/ui.md`.
- `clients/gmail.gs`, `docs/captura.md` — clientes de captura y notificaciones push (Android; iPhone solo con la app en la pantalla de inicio).

Reglas por área (se cargan al tocar esos archivos): `.claude/rules/ui.md`, `database.md`, `parser.md`.
El porqué de cada decisión técnica: `docs/decisiones.md`.

## Convenciones generales

- **Español neutro en todo texto visible** (tú; nada de voseo ni anglicismos). Comentarios de código en cualquier registro.
- **Cambios en pares**: si cambia la lógica (validación, opciones), el texto de la UI cambia en el mismo commit.
- **Ramas con merge** (nunca commits ni push directos a `main`, salvo docs, reglas, CLAUDE.md y memorias, que el usuario permite directo): `feat/ fix/ chore/ refactor/ docs/` desde `main`;
  cada push de la rama genera un preview en Vercel (usa la **misma base de producción**). Antes del merge:
  `npm test && npm run check && npm run build`; luego `git merge --no-ff` a `main` y push → despliega producción.
  Las migraciones se aplican antes del merge si el código nuevo las necesita.
- **Commits**: `feat|fix|chore|refactor|docs(scope): …` en español, una idea por commit.
- **Decisiones**: una decisión técnica nueva o un cambio de rumbo (arquitectura, datos, seguridad, parser, UX con
  evidencia medida) se anota en `docs/decisiones.md` en el mismo commit; si reemplaza otra, se marca la vieja como
  reemplazada en vez de borrarla. Sin datos personales ni de negocio: el archivo va tal cual a la copia pública.
- **Copia pública** (`Alejololer/ez-finance-showcase`): foto anonimizada sin historial; este repo sigue privado
  (logs del Action, issues del piloto e historial con datos reales). Ver decisión 2.7.
- **Infra por CLI**: `supabase` (Scoop, nunca `npx supabase`), `gh`, `vercel`. Secretos nunca en la terminal ni en el chat: leerlos de `.env` con pipes.
- **Verificar de punta a punta**: los cambios de captura/parser se prueban con un usuario temporal (crear con service role, borrar al final) y Claude real, no solo con tests.
- Sin React/shadcn/gráficas: HTML + Actions + Tailwind. Agregar islas solo con una necesidad concreta.
