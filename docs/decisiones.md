# Decisiones técnicas

Registro de las decisiones que dan forma a ez-finance: qué se decidió, por qué y qué se descartó. Sirve para no
volver a discutir lo ya resuelto y para entender el código sin tener que leer todo el historial.

**Cómo se mantiene**: una decisión nueva o un cambio de rumbo se anota aquí en el mismo commit que la implementa.
Una decisión que se revierte no se borra: se marca como **reemplazada** y se enlaza la que la sustituye. El detalle
operativo (cómo se hace) vive en `CLAUDE.md` y `.claude/rules/`; aquí va el porqué.

Formato de cada entrada: **Decisión** (lo que se hace), **Por qué** (el problema o la evidencia), **Descartado**
(alternativas consideradas, cuando las hubo) y **Consecuencias** (lo que obliga o limita). Fecha = cuándo se tomó.

## Índice

1. [Plataforma y arquitectura](#1-plataforma-y-arquitectura)
2. [Datos y seguridad](#2-datos-y-seguridad)
3. [Captura y parser](#3-captura-y-parser)
4. [Conciliación con el banco](#4-conciliación-con-el-banco)
5. [Producto](#5-producto)
6. [Interfaz](#6-interfaz)
7. [Proceso y operación](#7-proceso-y-operación)

---

## 1. Plataforma y arquitectura

### 1.1 Reescribir desde cero en vez de evolucionar el v1 — 2026-10-19

- **Decisión**: el v2 es un repositorio nuevo; el v1 (Next.js) queda archivado y su código no se reutiliza.
- **Por qué**: el v1 se dejó de usar porque registrar cada gasto a mano cansa. El v2 parte de otra premisa
  ("los gastos aparecen solos y tú solo confirmas"), y eso cambia el modelo de datos (eventos crudos, pendientes,
  conciliación) más de lo que convenía arrastrar.
- **Consecuencias**: nada del v1 es referencia; ante una duda se mira este repo.

### 1.2 Astro SSR + Actions con forms que funcionan sin JavaScript — 2026-10-19

- **Decisión**: Astro con render en el servidor (adaptador de Vercel). Todas las mutaciones son Astro Actions
  enviadas por `<form>` normales (`src/actions/index.ts`). Sin React, shadcn ni librerías de gráficas; HTML +
  Tailwind, y una isla de cliente solo ante una necesidad concreta.
- **Por qué**: la app es mayormente formularios y listas. Con forms nativos cada acción funciona aunque el JS no
  cargue (red móvil mala) y no hay estado de cliente que sincronizar. Menos dependencias, menos superficie.
- **Descartado**: SPA con React (el v1), gráficas con librería (las proporciones se dibujan con CSS, ver 6.1).
- **Consecuencias**: Astro manda los campos ausentes como `null`, no `undefined` → en zod `.nullish()`, nunca
  `.optional()` (rompía altas y descartes hasta que se corrigió). Cada handler valida sesión con `db(ctx)`.

### 1.3 El parser corre en GitHub Actions con Claude Code headless — 2026-10-19

- **Decisión**: `/api/ingest` solo guarda el aviso crudo. Un workflow (`parse-pending`) corre
  `scripts/parse-pending.ts`, que llama a `claude -p` con la suscripción (`CLAUDE_CODE_OAUTH_TOKEN`).
- **Por qué**: el token de suscripción, por política de Anthropic, solo puede usarlo el binario de Claude Code; no
  se puede usar con el SDK dentro de la app. Parsear dentro de Vercel exigiría una API key de pago por uso. Actions
  da el binario, un runner gratis y reintentos sin infraestructura propia.
- **Descartado**: parsear en la función de Vercel con el SDK (costo variable y otra credencial); un worker propio.
- **Consecuencias**: el parseo no es instantáneo (segundos a un minuto). `/api/ingest` dispara el workflow al
  llegar un aviso nuevo (`GITHUB_DISPATCH_TOKEN`) y un cron horario lo levanta si el dispatch falla. Si Claude falla
  (límite, red), el evento queda `new` y la corrida siguiente lo retoma. Los logs del runner no deben tener datos
  financieros (ver 2.6).

### 1.4 Node 24 ejecuta TypeScript directo en los scripts — 2026-10-19

- **Decisión**: `node scripts/parse-pending.ts`, sin paso de compilación. La lógica pura (`src/lib/parse.ts`,
  `statement.ts`, `card.ts`…) no depende de Astro y la comparten la app, los scripts y los tests.
- **Por qué**: un solo lenguaje y un solo lugar para cada regla; el Action no necesita build.

---

## 2. Datos y seguridad

### 2.1 Aislamiento por usuario en la base, no solo en la app — 2026-10-19

- **Decisión**: toda tabla tiene `user_id` y RLS `user_id = auth.uid()`. Las FKs a cuentas y categorías son
  compuestas `(id, user_id)`.
- **Por qué**: con FKs simples, un bug (o el parser con service role) podría colgar un movimiento de un usuario en
  la cuenta de otro. Con la FK compuesta la base lo rechaza incluso con service role.
- **Consecuencias**: la service role (salta RLS) solo se usa en `/api/ingest` (el usuario sale del token), en
  `scripts/` y para guardar errores sin sesión. Todo lo demás usa el cliente con la sesión del usuario.

### 2.2 Montos en centavos con signo; saldos calculados, nunca guardados — 2026-10-19

- **Decisión**: `amount_cents bigint` con signo (gasto negativo). El saldo es la vista `account_balances`, que
  suma solo lo `confirmed`.
- **Por qué**: enteros evitan errores de coma flotante; un saldo guardado se desincroniza en cuanto se edita o
  borra un movimiento. Con la vista, confirmar, editar o eliminar corrige el saldo sin código extra.
- **Consecuencias**: corregir un saldo es un movimiento más (2.4), no un `update`.

### 2.3 Una transferencia son dos filas — 2026-10-19

- **Decisión**: salida negativa y entrada positiva con el mismo `transfer_id`, insertadas en un solo `insert([...])`.
- **Por qué**: cada cuenta ve su pata con su signo y la vista de saldos no necesita casos especiales; el insert
  único las hace atómicas.
- **Consecuencias**: confirmar, descartar o eliminar actúa sobre ambas patas (`feat(movimientos)` 2026-11-03).

### 2.4 Ajustes de saldo como tipo propio — 2026-10-19

- **Decisión**: `kind = 'adjustment'` registra la diferencia contra el saldo real.
- **Por qué**: cuadrar la cuenta con el banco no es gastar ni ganar; si contara, ensuciaría el resumen del mes.

### 2.5 Fecha "de hoy" en hora de Ecuador — 2026-10-20

- **Decisión**: `today()` de `src/lib/money.ts`; nunca `toISOString().slice(0, 10)`.
- **Por qué**: en UTC, desde las 19:00 locales ya es mañana. Un ajuste de saldo quedó un día adelante y el interés
  del día salió en cero.

### 2.6 Nada de datos financieros en los logs del Action — 2026-10-19

- **Decisión**: los scripts solo imprimen ids y estados (`event 123: pending`). Los errores completos van a la tabla
  `reports`, no a la consola.
- **Por qué**: los logs de GitHub Actions los ve quien tenga acceso al repo y se guardan 90 días; no son un lugar
  para montos, comercios ni texto de avisos.
- **Consecuencias**: depurar el parser se hace leyendo `ingest_events`/`reports` en la base, no el log.

### 2.7 El repositorio principal se queda privado; se publica una copia anonimizada — 2026-11-04

- **Decisión**: el repo de trabajo no se hace público. Para mostrar el proyecto se publica una copia aparte, sin
  historial, con nombres, números de cuenta, ids de proyecto, URLs de producción y documentos de negocio quitados.
- **Por qué**: hacer público el repo expondría (a) el historial de git, que guarda textos reales de estados de
  cuenta en los tests (nombre completo, números de cuenta), y borrarlos en un commit no los saca del historial;
  (b) los issues que crea el botón "reportar" de los testers; (c) los logs de Actions, pasados y futuros, donde un
  error no capturado podría imprimir el prompt (lleva cuentas y comercios del usuario) o detalles de una fila.
  El código en sí no expone datos (RLS y secretos), pero el resto sí.
- **Descartado**: reescribir el historial (`git filter-repo`) y abrir el repo: deja abiertos los issues y los logs,
  y un error de limpieza no tiene vuelta atrás.
- **Consecuencias**: la copia pública es una foto a una fecha; se regenera a mano. Sus tests usan datos
  ficticios con la misma estructura que los reales.

### 2.8 Piloto cerrado con lista de correos en la base — 2026-10-21

- **Decisión**: el hook `before_user_created` de Supabase Auth rechaza cualquier registro (correo o Google) cuyo
  correo no esté en `pilot_emails`.
- **Por qué**: es una app con datos financieros en piloto; el control tiene que estar antes de que exista el
  usuario, no en una pantalla que se puede saltar.
- **Consecuencias**: los usuarios temporales de prueba también deben estar en la lista (y se borran al final).

---

## 3. Captura y parser

### 3.1 Capturar los avisos que el banco ya manda — 2026-10-19

- **Decisión**: la fuente de datos son los correos (Apps Script en Gmail), las notificaciones del celular
  (MacroDroid en Android) y Atajos en iOS, todos con `POST /api/ingest` y un token por usuario (se guarda su hash).
- **Por qué**: no pide credenciales del banco ni depende de una API de open banking; los avisos llegan solos y en
  tiempo casi real. El texto crudo se guarda (`ingest_events`, deduplicado por hash) para poder reprocesarlo.
- **Consecuencias**: el parser depende del formato de cada banco (hoy Pichincha y PacifiCard). Cada canal tiene
  huecos distintos: Pichincha no avisa por correo las transferencias recibidas (solo por push), y DeUna solo avisa
  por push.

### 3.2 La salida del LLM no es confiable: todo pasa por `decide()` — 2026-10-19

- **Decisión**: Claude solo extrae campos con un JSON schema. `decide()` (puro, con tests) valida monto, moneda,
  fecha (±7 días), comprobante e ids de cuenta y categoría contra los del usuario. Ante cualquier duda el aviso va a
  `review`. Nada queda confirmado sin que el usuario lo toque en la bandeja.
- **Por qué**: el texto viene de afuera y puede intentar inyección de instrucciones; un error del modelo no puede
  convertirse en un movimiento real. `claude -p` corre sin herramientas (`--tools ""`, `--strict-mcp-config`), así
  que lo peor que puede pasar es una extracción mala, que `decide()` filtra.
- **Consecuencias**: cuando haya que elegir entre automatizar más o equivocarse menos, gana `review`.

### 3.3 Haiku + few-shot con avisos reales anonimizados — 2026-10-25

- **Decisión**: modelo `haiku` con 10 ejemplos (`EXAMPLES` en `parse.ts`) sacados de avisos reales, con nombres y
  cuentas ficticios (ids 901-903, que no chocan con ids reales).
- **Por qué**: medido con 50 avisos reales × 3 corridas contra lo confirmado: comercio correcto 70 → 100 %,
  descripción 3 → 100 %, consistencia entre corridas 54 → 98 %, sin regresión en estado, monto ni cuenta. Haiku es
  rápido y su costo es despreciable.
- **Consecuencias**: **todo cambio de prompt exige una eval antes/después** con los avisos reales y la línea base
  de `main`; se implementa solo si no empeora estado/monto/cuenta. El aviso real va con una etiqueta final después
  de los ejemplos: sin ella Haiku a veces respondía "no hay aviso" (2/30 → 0/60).

### 3.4 Una transferencia es interna solo si el aviso nombra ambas cuentas — 2026-10-19

- **Decisión**: `decide()` recibe el texto y exige ver ambas cuentas del usuario (por sufijo de ≥3 dígitos al final
  de una secuencia, o por nombre completo). Falta el destino → gasto a un tercero; falta el origen → ingreso; faltan
  ambas → `review`.
- **Por qué**: el usuario transfiere a otras personas. Si el modelo "adivina" que el destino es una cuenta propia,
  un pago a un tercero desaparece del gasto del mes. El texto es la evidencia, no la opinión del modelo.
- **Consecuencias**: no se relaja nunca. La coincidencia por sufijo cubre tarjetas enmascaradas
  (`XXXXXXX123` ↔ `123`).

### 3.5 Duplicados en capas, de lo seguro a lo dudoso — 2026-10-19 a 2026-10-23

- **Decisión**, en orden: (1) mismo texto (`raw_hash`); (2) mismo comprobante del banco; (3) coincide con un pago
  registrado a mano; (4) correo y push del mismo movimiento (mismo monto con signo, canales distintos, ±15 min) →
  gana el correo; (5) mismo monto ±1 día **y mismo tipo** → se marca `duplicate_of` y decide el usuario.
- **Por qué**: Pichincha avisa la misma transferencia por correo y por push. Las capas seguras se resuelven solas;
  la dudosa (5) la decide una persona. "Mismo tipo" porque pasar $X del ahorro a la corriente y pagar $X con débito
  el mismo día son dos movimientos reales.
- **Consecuencias**: la bandeja **retiene 8 min** lo que llega del celular (`held()`) para que el correo, que Gmail
  revisa cada 5 min, lo reemplace antes de que el usuario confirme el push. Se aceptó como compromiso que un push de
  transferencia sin su correo quede como ingreso en la cuenta destino (el push no nombra el origen).

### 3.6 Historial de comercios en el prompt — 2026-10-19

- **Decisión**: el prompt recibe hasta 40 pares comercio/persona → categoría de lo ya confirmado.
- **Por qué**: lo que el banco camufla solo lo sabe el usuario: un pago con DeUna llega como transferencia a nombre
  del beneficiario, y una "transferencia a una persona" puede ser la farmacia del barrio.
- **Consecuencias**: esos nombres vienen de avisos (no confiables): se recortan a una línea y 60 caracteres.

### 3.7 Lo de formato fijo se lee sin Claude — 2026-10-19 / 2026-10-22

- **Decisión**: los estados de cuenta (`statement.ts`) y las recargas de DeUna (`deunaTopup()`) se leen con código
  determinista antes de llamar al modelo.
- **Por qué**: un estado de cuenta es largo (gasta contexto) y tiene formato fijo; un parser propio es exacto y
  verificable (la conciliación del PDF se valida: anterior + créditos − débitos + interés = actual).
- **Consecuencias**: si el banco cambia el formato, falla la validación y el evento va a `review`, nunca a un saldo
  incorrecto.

---

## 4. Conciliación con el banco

### 4.1 El estado de cuenta corrige, con límite — 2026-10-19 / 2026-10-27

- **Decisión**: `scripts/reconcile.ts` (corre tras el parser, también si este falló) lleva el saldo al corte al del
  banco con un ajuste recalculable. Diferencias de hasta $5 se ajustan solas; más, el aviso vuelve a la bandeja con
  cuánto más o menos tiene el banco.
- **Por qué**: centavos de redondeo o un cargo pequeño no merecen la atención del usuario; una diferencia grande
  probablemente es un movimiento que falta y ajustarla lo escondería.
- **Consecuencias**: el banco no corta a medianoche (una transferencia de las 23:24 cayó en el corte siguiente):
  `cutoffDiff()` descuenta un movimiento del día del corte o del siguiente si explica la diferencia. El mensaje nunca
  sugiere "ajustar saldo": eso movería el saldo de hoy, que estaba bien.

### 4.2 Interés diario como movimientos — 2026-10-19

- **Decisión**: cuentas con tasa anual reciben una fila de interés por día (`INT-YYYYMMDD`, append-only).
- **Por qué**: el saldo de la app se parece al del banco todos los días, no solo al corte.

### 4.3 Tarjetas: lo que manda es el pago de contado del banco — 2026-10-24 / 2026-10-25

- **Decisión**: el estado de PacifiCard guarda el "pago de contado" (lo que el banco cobra), no la suma de compras.
  Cada línea del detalle se cruza con lo registrado (−10/+3 días); los cargos que falten entran como pendientes y un
  pago que la app no conoce manda el aviso a revisión. La fecha máxima de pago del estado manda sobre el día
  configurado. El corte que cae en fin de semana se adelanta al viernes.
- **Por qué**: el banco factura lo procesado; las compras aún en tránsito pasan al corte siguiente, y el banco puede
  mover el día de pago.
- **Consecuencias**: el PDF es una imagen; el OCR de Drive separa las columnas y el detalle se reconstruye por orden,
  validado contra los subtotales del banco. Si no cuadra, se usa solo el total.

### 4.4 Cargos de tarjeta como pendientes — 2026-10-20

- **Decisión**: desgravamen mensual (por tramos de deuda) y costo anual se proponen como pendientes al corte;
  `fees_through` evita recrear uno que el usuario descartó.
- **Por qué**: son cargos previsibles que el banco no avisa; proponerlos (no confirmarlos) respeta 3.2.

---

## 5. Producto

### 5.1 La bandeja es el centro — 2026-10-19

- **Decisión**: todo lo automático entra como `pending` en `/inbox`; la acción principal (confirmar/descartar) va a
  la vista y los campos quedan en "editar".
- **Por qué**: el valor es "tú solo confirmas"; confirmar tiene que costar un toque. Tras cada envío la página vuelve
  a la misma altura, así el ítem siguiente queda donde estaba el confirmado.

### 5.2 Cuenta común con el mismo porcentaje del ingreso — 2026-10-26

- **Decisión**: la titular comparte una cuenta con otra persona de la app; cada una aporta el mismo % de su ingreso
  del mes anterior, con día límite y arrastre de lo que falte (`shared_split()` + `src/lib/split.ts`).
- **Por qué**: un reparto proporcional al ingreso: si los ingresos difieren, mitad y mitad pesa más sobre quien
  gana menos.
- **Consecuencias**: las policies de RLS de la cuenta común son **aditivas** y comparan columnas (evita recursión).
  Solo la invitada puede aceptar (si la titular pudiera, vería los ingresos de cualquiera). Las funciones de cálculo
  son `security definer`: excepción deliberada a "lógica fuera de la base", porque necesitan sumar ingresos de dos
  usuarios sin exponer sus filas. El push "te envió…" del aporte no es un ingreso: el parser lo absorbe.

### 5.3 Notificaciones push web en vez de app nativa — 2026-11-01

- **Decisión**: Web Push con VAPID, manifest y service worker; payload Declarative Web Push con respaldo para
  navegadores que no lo soportan. Al terminar cada corrida, una notificación por usuario con lo que llegó por
  correo.
- **Por qué**: en Ecuador no hay instalación de apps fuera de la App Store, y una app nativa exige cuentas de
  desarrollador y revisión. La web en la pantalla de inicio basta para "tienes N movimientos por confirmar".
- **Consecuencias**: en iPhone solo funciona con la app instalada en la pantalla de inicio. Lo que llegó por push
  del celular no se notifica (el banco ya avisó). Un fallo de envío va a `reports` y nunca frena al parser.

### 5.4 Reportes de errores y del usuario — 2026-10-21

- **Decisión**: errores de servidor, navegador y parser van a la tabla `reports`. El botón "reportar" crea un issue
  de GitHub con rastro y contexto técnico, sin datos financieros.
- **Por qué**: en un piloto los testers no van a abrir la consola; el error completo de Postgres (`details` puede
  traer valores) se queda en la base y al issue solo va id/código/mensaje.
- **Consecuencias**: los issues son otra razón para que el repo siga privado (2.7).

### 5.5 IVA en una fila aparte — 2026-10-24

- **Decisión**: al registrar un gasto se puede sumar el IVA (15 %) como una fila separada; solo en gastos.
- **Por qué**: en algunos cobros el banco carga el IVA aparte y sin aviso (por ejemplo, en servicios digitales); el
  botón "con IVA" lo registra al confirmar el gasto, y la fila propia lo deja visible como lo que es.
- **Consecuencias**: un doble envío no duplica el IVA (solo se agrega si esa vez se confirmó).

---

## 6. Interfaz

### 6.1 Identidad propia sin librerías ("statue hall") — 2026-10-20

- **Decisión**: negro profundo, líneas finas, Fraunces + Inter Tight y una escultura 1-bit tramada (Bayer) de fondo
  en WebGL propio (`Sculpture.astro`, sin three.js). Las proporciones se dibujan con relleno tramado de CSS
  (`.dither`). Un estilo por rol (`.item`, `.money`, `.prompt`…), sin tamaños inventados.
- **Por qué**: continuidad con el portafolio personal (de ahí sale el prototipo). WebGL propio porque la escena es
  un solo shader y no justifica una dependencia.
- **Descartado**: la primera estética de terminal (barra tipo tmux, VT323, ventanas retro), reemplazada al día
  siguiente.
- **Consecuencias**: color solo en montos y avisos; contraste AA medido sobre el peor píxel de la trama (`dim`
  #9a9a9a sobre superficies al 90 %: 3.45 → 5.9:1).

### 6.2 Navegación sin recargar (`ClientRouter`) — 2026-10-20

- **Decisión**: el router de Astro trae cada página por fetch y la reemplaza en el mismo documento; la escultura y
  el lente persisten (`transition:persist`).
- **Por qué**: Firefox (el navegador principal del usuario) no tiene view transitions entre documentos: cada clic o
  POST mostraba su lienzo gris y la escultura se reiniciaba.
- **Consecuencias**: los scripts del Layout corren una sola vez; lo que depende de la página va en
  `astro:after-swap`. El login con Google recarga completo (redirige a otro origen). Ningún elemento lleva
  `view-transition-name` (el canvas taparía el contenido).

### 6.3 Rendimiento medido en el equipo real — 2026-10-22 / 2026-10-24

- **Decisión**: la escultura se dibuja a 60 fps con constantes escaladas por el tiempo transcurrido; sin
  `backdrop-filter` en superficies que no tapan la escultura; no se dibuja cuando queda fuera de cuadro.
- **Por qué**: medido en una laptop con GPU integrada a 120 Hz en Firefox: 76 % → 43 % de GPU; en celular emulado,
  3.7 % → 0.1 % de CPU fuera de cuadro. Se mide uso de GPU, no fps (los fps salen planos aunque haya lag).
- **Descartado**: suavizar el lente (iba 40-60 px detrás del puntero: se sentía como lag). Va 1:1.
- **Consecuencias**: el ruido usa interpolación quíntica (la cúbica dejaba pliegues) y un techo
  `amp × freq ≤ 0.8` (más arriba la figura gotea).

### 6.4 Mobile-first, con pantallas raras incluidas — 2026-10-20 / 2026-10-24

- **Decisión**: clases base para celular, gutter de 24 px, superficies de borde a borde en celular, sin `<table>` y
  una variante `cover:` para la pantalla externa de plegables (~360×400).
- **Por qué**: casi todo el uso es desde el celular (confirmar la bandeja). Con 16 px los montos quedaban pegados al
  borde en un plegable real.

### 6.5 Confirmaciones propias, no `confirm()` — 2026-10-20

- **Decisión**: los destructivos usan `Confirm.astro` (popover dentro del form, "sí, …" + "cancelar").
- **Por qué**: el diálogo del navegador no sigue la identidad visual ni el flujo del form (el popover vive dentro
  del form y envía con `formnovalidate`).

---

## 7. Proceso y operación

### 7.1 Ramas con merge y previews sobre la base de producción — 2026-10-19

- **Decisión**: cada cambio de código en una rama (`feat/ fix/ …`), `npm test && npm run check && npm run build` y
  `git merge --no-ff` a `main`, que despliega. Docs y reglas pueden ir directo a `main`.
- **Por qué**: cada push de rama genera un preview en Vercel para probar en el celular antes de producción.
- **Consecuencias**: los previews usan **la misma base de producción** (un solo proyecto de Supabase en el piloto):
  se prueba con usuarios temporales que se crean y se borran. Las migraciones se aplican antes del merge del código
  que las necesita.

### 7.2 Verificar de punta a punta con Claude real — 2026-10-19

- **Decisión**: los cambios de captura o parser se prueban con un usuario temporal y el modelo real, no solo con
  tests unitarios.
- **Por qué**: el comportamiento del modelo ante avisos reales es justamente lo que los tests no cubren
  (ej. "no hay aviso" tras los ejemplos, 3.3).

### 7.3 Contexto para el asistente por área — 2026-10-19

- **Decisión**: `CLAUDE.md` tiene lo general; las reglas de UI, base de datos y parser están en `.claude/rules/`,
  cada una con las rutas que la activan.
- **Por qué**: el proyecto se desarrolla con Claude Code; cargar solo las reglas del área que se toca mantiene el
  contexto corto y las reglas cerca del código.

### 7.4 Infraestructura por CLI y secretos fuera del chat — 2026-10-19

- **Decisión**: Supabase, GitHub y Vercel se operan por CLI; los secretos se leen de `.env` con pipes, nunca se
  escriben en la terminal ni en el chat.
- **Por qué**: lo que pasa por la terminal o el chat queda en historiales y transcripciones.
