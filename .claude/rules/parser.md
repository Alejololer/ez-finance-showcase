---
paths:
  - "src/lib/parse*.ts"
  - "src/lib/statement*.ts"
  - "scripts/**"
  - "src/pages/api/ingest.ts"
  - ".github/workflows/**"
  - "clients/**"
  - "docs/captura.md"
---

# Captura y parser

- **Token de Claude**: el parser usa `CLAUDE_CODE_OAUTH_TOKEN` (suscripción) vía `claude -p` en GitHub Actions.
  Por política de Anthropic ese token **solo** sirve para el binario de Claude Code: nunca usarlo con el SDK de
  Anthropic dentro de la app. Parseo dentro de Vercel requeriría una API key de Console.
- `claude -p` corre con `--tools "" --strict-mcp-config --no-session-persistence --model haiku
  --output-format json --json-schema …`; la respuesta está en `structured_output`.
- **La salida del LLM no es confiable** (el texto viene de afuera y puede intentar inyección): todo pasa por
  `decide()`, que valida montos, ids de cuenta/categoría contra los del usuario, moneda, fecha (±7 días) y
  comprobante. Ante cualquier duda → `review`, nunca un movimiento confirmado.
- Si Claude falla (límite, red), el evento queda `new` y el script termina con error: la próxima corrida lo retoma.
- **Duplicados**, en orden: (1) mismo texto → `raw_hash` único en `ingest_events`; (2) mismo comprobante
  (`reference`, ej. "Documento" de Pichincha) → el aviso se ignora; (3) reconciliación con pago manual (abajo);
  (4) mismo monto ±1 día **y mismo tipo** (y misma cuenta de origen en transferencias) → `duplicate_of`, decide el
  usuario en `/inbox`. El tipo importa: el usuario pasa $X del ahorro a la corriente y paga $X con débito.
  Antes de (4): **correo ↔ push** del mismo movimiento (mismo monto con signo, canales distintos, ±15 min entre
  `received_at`) → queda el correo; el push se ignora, o si llegó primero su pendiente se borra (si ya estaba
  confirmado, `duplicate_of`). Pichincha avisa por ambos lados las transferencias enviadas y las propias (el push
  de una transferencia propia es un "¡Recibiste…! <tu nombre> te envió…"). Nunca entre dos push ni dos correos.
  Para que el push no se confirme antes de que llegue el correo (Gmail se revisa cada 5 min), `/inbox` y el contador
  del menú **retienen 8 min** lo que viene de android/ios (`held()` en `src/lib/money.ts`); el parser no espera.
  Push en `review` sin monto ("¡Recibiste dinero!") a ±3 min de un correo con movimiento → `ignored` (en ambos
  órdenes de llegada).
- **DeUna (app)**: solo push de DeUna (ni correo ni push de Pichincha, tampoco en la recarga). "Recargaste $X en tu cuenta Deuna" → `deunaTopup()` sin Claude: transferencia
  cuenta por defecto → cuenta cuyo nombre contiene "DeUna" (sin esa cuenta, `ignored`). "Pagaste a X por $Y" →
  gasto desde la cuenta DeUna (lo dice el prompt). Coma decimal.
- **Transferencias**: el prompt lista las cuentas del usuario (id, nombre, tipo, números); el LLM devuelve
  `from_account`/`to_account`. Con solo dos cuentas y **exactamente una** pata conocida se deduce la otra.
- **Una transferencia es interna solo si ambas cuentas aparecen en el aviso** (`decide()` recibe `ctx.text`):
  por un número suyo al final de una secuencia de dígitos (`******9306`, `542258XXXXXXX458`) o por su nombre
  completo ("PACIFICARD"). Destino no mencionado → gasto desde el origen (envío a un tercero); origen no
  mencionado → ingreso en el destino; ninguno → `review`. Nunca relajar esto: el usuario transfiere a otras personas.
- Coincidencia de cuenta por **sufijo** (≥3 dígitos): `458` ↔ `542258XXXXXXX458`. PacifiCard
  (`notificaciones@infopacificard.com.ec`, "PacifiCard: Consumos") enmascara 6+3 dígitos y no trae comprobante.
- **Reconciliación con pagos manuales** (botón "registrar pago" en `/accounts`): un aviso de transferencia con
  mismo origen, destino y monto (±3 días) que una transferencia `source = 'manual'` se absorbe (`ignored`,
  "Reconciliado…") y le copia el comprobante; si ambos tienen comprobantes distintos, es otro pago y va a la bandeja.
  Si ya hay una transferencia pendiente hacia esa tarjeta o cuenta común, la UI esconde "registrar pago"/"registrar
  aporte" y manda a confirmarla en la bandeja (la reconciliación no mira pendientes: sería un pago doble).
- No loguear texto crudo ni montos en el Action (los logs no son lugar para datos financieros).
- Al cambiar el prompt o `decide()`: agregar casos a `parse.test.ts` y probar con un aviso real de Pichincha
  (hay ejemplos en `ingest_events`) usando el binario local (`CLAUDE_BIN` en Windows).
- **Eval antes/después obligatoria** para cambios de prompt: replay de los `ingest_events` reales (cuentas y
  categorías de cada usuario, historial sin el comercio del propio evento, 3 corridas) contra un gold armado de lo
  confirmado; línea base con el prompt de `main`. Se implementa solo si no empeora status/monto/cuenta y mejora el resto.
- **Few-shot** (`EXAMPLES` en `parse.ts`): avisos reales anonimizados con cuentas ficticias 901-903 (no colisionan
  con ids reales; `decide()` descarta ids ajenos igual). Convenciones que enseñan: merchant **tal como lo escribe el
  banco** (sin normalizar mayúsculas ni prefijos de pasarela), transferencias propias "Origen → Destino",
  supermercados → Supermercado, retiros de efectivo y personas sin concepto → `null`, el Concepto de la transferencia
  orienta la categoría, nunca "Otros" por descarte. El test valida cada salida contra `LlmOutput` y `decide()`.
- `/api/ingest` dispara el workflow solo si el aviso es nuevo; si el dispatch falla, el cron horario lo levanta.
- **Estados de cuenta** (`src/lib/statement.ts`): se leen **sin Claude** antes de llamarlo (formato fijo, el
  texto es grande). Cuenta y corte salen del **cuerpo del correo** (`Cuenta: 2200017105`, `Estado de cuenta del
  mes: 08-10-2026`), nunca del PDF (su detalle menciona otras cuentas); saldos de la "CONCILIACIÓN" del PDF, que
  se valida: anterior + créditos − débitos (+ interés) = actual. "(100)" junto a créditos es la cantidad de
  movimientos. El resultado va a `statements`.
- **Estado de PacifiCard** (`estadodecuenta@pacificard.ec`, "Estado de Cuenta PacifiCard"): tarjeta (`X458`),
  corte y fecha máxima de pago (`23/OCT/2026 | 09/NOV/2026`, meses ENE…DIC/SET; el banco puede mover el día de
  pago, así que se guarda en `statements.due_date`) y "Pago de Contado" del **cuerpo**; la fila de `statements` guarda
  `-pago de contado`, no el saldo (el banco factura lo procesado; las compras en tránsito pasan al corte siguiente).
  El PDF es imagen: `gmail.gs` manda la página 1 OCR (hasta "CONCEPTOS BÁSICOS"); el OCR **separa las
  columnas**: fechas+descripciones (`OCT/22 ⏎ 012074 GOOGLE Apple Music`), luego las 7 etiquetas del resumen y recién
  ahí tipos y montos mezclados. Fila N = N-ésimo tipo y N-ésimo monto tras "INTERÉS POR MORA"; los 7 últimos montos
  son el resumen (total de contado = pago de contado del correo, subtotales de consumos y pagos, intereses). Si no
  cuadra, `lines: null` y el evento a `review`; el total vale. `missingLines()` cruza cada línea con movimientos pending+confirmed de
  la tarjeta (mismo monto, −10/+3 días, el más cercano, uno por línea): cargos faltantes → pendientes
  ("Del estado de cuenta"), pagos faltantes → `review`. El corte que cae en fin de semana se adelanta al viernes
  (`cycle()` en `card.ts`).
- **`scripts/reconcile.ts`** (paso con `if: always()` tras el parser): interés diario append-only en cuentas con
  `interest_rate` (`reference 'INT-YYYYMMDD'`, `source 'auto'`; la primera vez desde el primer movimiento de la
  cuenta), cargos de tarjetas tras cada corte (`cardFees()` en `card.ts`: `DESG-YYYYMMDD` / `ANUAL-YYYY`, como
  **pendientes** con fecha del corte; `fees_through` evita repetirlos y la primera vez solo se marca) y ajuste recalculable por estado de cuenta
  (`reference 'EDC-<id>'`): espera si hay pendientes ≤ corte, ignora cortes anteriores al primer movimiento de la
  cuenta, |dif| ≤ $5 (`MAX_AUTO`) se ajusta, más → el evento vuelve a `review` con un mensaje corto (cuánto más o menos
  tiene el banco; nunca sugerir "ajustar saldo": movería el saldo de hoy). El banco no corta a medianoche (una
  transferencia de las 23:24 cayó en el corte siguiente): si **un** movimiento (no ajuste) del día del corte o del
  siguiente explica la diferencia, `cutoffDiff()` lo descuenta y se ajusta solo el resto. Las tarjetas se saltan (su fila es lo facturado). En `/inbox` todo review de
  estado de cuenta (error "Estado de cuenta…") muestra el texto plegado; el de saldo al corte ("Estado de cuenta de
  <cuenta> al …", de reconcile) además solo ofrece "descartar aviso". Mantener esos prefijos.
- **Cuenta común**: Pichincha avisa solo a la titular (un correo y un celular por cuenta, también en cuentas
  conjuntas). El parser suma a las cuentas del evento las comunes aceptadas de otra titular (sin `is_default`): el
  correo de la pareja "Realizaste una transferencia… ******1234" queda como transferencia hacia la común, con la pata
  de entrada a nombre de la titular. El push de la titular "¡Recibiste X! <pareja> te envió…" (cae como ingreso en
  su cuenta por defecto) **no es un ingreso: es el aporte**. A ±15 min del correo lo absorbe el emparejamiento
  correo↔push (la pata de entrada es de la titular); más tarde, si hay una pata de entrada del mismo monto ±1 día en
  una cuenta común suya, el push se ignora ("Aporte a la cuenta común"); si llegó antes, al insertar la transferencia
  se borra su ingreso pendiente y su evento queda ignorado (`dropContributionPush()`, también cuando el correo se
  cruza con un aporte registrado con el botón). El botón no dispara el parser: si no llega correo, `/inbox` marca
  como posible duplicado todo ingreso del celular con el mismo monto (±1 día) que una transferencia que entró a una
  cuenta del usuario (cubre también transferencias propias anotadas a mano). Verificado E2E con Claude real en todos los órdenes. Límites
  conocidos: un ingreso real de un tercero por el mismo monto ±1 día que un aporte se absorbería; un depósito que la pareja deja pendiente
  (la titular no lo ve en su bandeja: solo tiene la pata de entrada) frena el ajuste de `reconcile.ts` de la
  cuenta común y `leaveShare` se niega hasta resolverlo.
- **Historial de comercios**: el prompt recibe hasta 40 pares comercio/persona → categoría de lo ya confirmado.
  Así se reconocen beneficiarios recurrentes: DeUna llega como interbancaria ("TRANSFERENCIA · Pago realizado
  correctamente · Banco destino: DE UNA · Nombre del beneficiario: …", comercio o persona) y las transferencias a
  personas que en realidad son comercios. Pichincha **no** avisa por correo las transferencias recibidas (todos sus
  "¡Transferencia exitosa!" son "Realizaste"): los ingresos de terceros solo llegan por notificación de Android.
- **Notificaciones push**: `parse-pending.ts` junta por usuario lo que entró a la bandeja (`toInbox()`) y al final
  (`finally`, también si un evento falló) manda una notificación con `inboxNotice()`. Solo eventos de **correo**
  (los del celular ya los avisó el banco y `held()` los retiene). Sin `VAPID_*` no hace nada; un fallo de envío va a
  `reports` y nunca relanza. El payload es Declarative Web Push (`web_push: 8030`) y `public/sw.js` lo muestra en los
  navegadores sin soporte declarativo: cambiar el formato en los dos lados a la vez.
