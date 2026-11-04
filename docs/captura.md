# Captura automática de movimientos

Todo termina en `POST https://TU-APP.vercel.app/api/ingest`:

```http
Authorization: Bearer <token de /settings>
Content-Type: application/json

{ "source": "email" | "android" | "ios", "text": "<texto de la alerta>", "received_at": "<ISO opcional>" }
```

Responde `202` (guardado o duplicado exacto), `401` token inválido, `400` body inválido, `413` > 16 KB.
El texto se guarda crudo y `/api/ingest` dispara el workflow `parse-pending` (GitHub Actions; cron horario de
respaldo), que lo interpreta con Claude Code y crea la transacción como **pendiente** en `/inbox`. Nada entra al saldo sin que lo confirmes.

## 0. Una vez: token

`/settings` → **Generar token**. Se muestra una sola vez; regenerarlo invalida el anterior en todos los dispositivos.

## 1. Gmail (Apps Script)

Los pilotos siguen los pasos de `/settings`: copiar la plantilla → pegar el token en la línea 5 → ejecutar
`install`. `install` crea la etiqueta `ez-finance`, los filtros de `FILTERS` (Pichincha, PacifiCard y estados de
cuenta; no duplica si se repite) y el trigger de `run` cada 5 min. Una copia no hereda los triggers.

**Plantilla** (mantenedor): proyecto de Apps Script cuyo código es `clients/` (`gmail.gs` + `appsscript.json`,
que trae activados los servicios avanzados Drive v3 y Gmail v1). Se sincroniza con
`npx @google/clasp push` (`.clasp.json` en la raíz; `clasp login` una vez, con la Apps Script API activada en
<https://script.google.com/home/usersettings>). Está compartido como "cualquiera con el enlace: lector" y su URL
va en `GMAIL_TEMPLATE` de `src/pages/settings.astro`. Cambiar `gmail.gs` no actualiza las copias ya hechas:
cada usuario debe volver a copiarla.

### Estados de cuenta e intereses

- Filtro de Gmail: `from:documentoselectronicos@pichincha.com subject:"ESTADO CUENTA"` → etiqueta `ez-finance`.
  El script convierte el PDF a texto y envía solo el resumen (hasta "DETALLE DE MOVIMIENTOS"). Se lee sin Claude
  (`src/lib/statement.ts`) y `scripts/reconcile.ts` lleva el saldo de la app al del banco en la fecha de corte:
  diferencias de hasta $5 se ajustan solas; más que eso aparece en `/inbox` para que revises qué falta.
  `pdfPreview` muestra en el registro lo que se enviaría, sin enviarlo.
- PacifiCard: filtro `from:estadodecuenta@pacificard.ec subject:"Estado de Cuenta"` (está en `FILTERS`; quien ya
  instaló la plantilla pega el `gmail.gs` nuevo y vuelve a ejecutar `install`). El banco cobra lo que ya
  **procesó**, no lo comprado hasta el corte: una compra del 19 puede facturarse en el corte siguiente. Por eso:
  - del cuerpo del correo salen la **fecha máxima de pago** (manda sobre el "día de pago" de la cuenta: el banco
    puede moverla) y el **pago de contado**, que manda sobre el cálculo de la app ("lo que dice el banco"
    en `/accounts` se llena solo; a mano solo si el correo aún no llega);
  - del PDF (es una imagen: lo lee el OCR de Drive) se envía la página 1 con el detalle. Cada línea se cruza con lo
    registrado (mismo monto, de 10 días antes a 3 después); los cargos que falten —emisión de tarjeta, IVA de
    servicios digitales, intereses: el banco no los avisa— llegan a `/inbox` como pendientes. Un pago que la app no
    tiene manda el aviso a revisión. Si el OCR no cuadra con los subtotales del banco, se guarda solo el total.
  - El saldo de la tarjeta nunca se ajusta solo: la diferencia con el banco son compras aún en tránsito.
- Intereses: en `/accounts` → editar → "Interés anual (%)" (Ahorro Flexible: 4.75). Se registra una fila
  "Intereses" por día con `round(saldo × tasa / 36500)`.

## 2. Android (MacroDroid)

1. Disparador: **Notificación recibida** → apps Banco Pichincha y DeUna, sin filtro de texto.
2. Acción: **Solicitud HTTP** → POST a la URL, header `Authorization: Bearer <token>`,
   cuerpo JSON: `{"source":"android","text":"[app_name] [hour]:[minute] [notification_title] [notification]"}`.

Tasker funciona igual (perfil *Notification* + acción *HTTP Request*).

### Qué llega solo por push

- **Ingresos**: Pichincha no avisa por correo las transferencias que **recibes**; solo con un push de su app:
  "💰¡Recibiste 1.00! · Ana Vega te envió 1.00. 20 OCT 2026, 13:34".
- **App DeUna** (pagar con QR desde DeUna, no desde la banca móvil): ni la recarga ni el pago generan correo ni push
  de Pichincha. Solo los push de DeUna:
  "✅ Recargaste $0,01 · Recargaste $0,01 en tu cuenta Deuna! el 22 oct 2026" (dinero de Pichincha a DeUna) y
  "✅ ¡Listo! Pagaste $0,01 · Pagaste a Ana Vega por $0,01 el 22 oct 2026". DeUna a veces recarga justo el
  pago y a veces guarda saldo, así que conviene una cuenta llamada **"DeUna"** en `/accounts`: la recarga es una
  transferencia de la cuenta por defecto a DeUna (`deunaTopup()`, sin Claude) y el pago un gasto desde DeUna. Sin
  esa cuenta, la recarga se ignora y el pago sale de la cuenta por defecto.

Lo demás llega **por ambos lados**: las transferencias que envías ("¡Transferencia exitosa! La transferencia por
$0.01 a la cuenta ******7250 fue exitosa…"), las pagadas con DeUna desde la banca móvil e incluso las transferencias
entre tus cuentas (llega un "¡Recibiste 10.00! <tu nombre> te envió…"). El parser junta correo y push con el mismo
monto y ±15 min entre sí: queda el del correo, que trae comprobante y cuentas.

**Token**: es el mismo que usa Gmail (hay uno solo por usuario). No lo regeneres, porque Gmail dejaría de
funcionar. Cópialo de <https://script.google.com> → tu copia de la plantilla → línea 5 de `gmail.gs` (instalaciones
viejas: Propiedades del script → `INGEST_TOKEN`). Si lo perdiste, regenéralo en `/settings` y pega el nuevo en ambos lados.

Paso a paso (los nombres pueden variar un poco según la versión de MacroDroid):

1. Instala MacroDroid (Play Store) → **Añadir macro** → nombre "ez-finance".
2. **Disparador** ＋ → *Aplicaciones* → **Notificación** → *Notificación recibida*.
   - Aplicaciones: **Seleccionar aplicaciones** → marca **Banco Pichincha**.
   - Marca también **DeUna**. Sin filtro de texto: promociones y códigos se ignoran solos.
   - La primera vez pide **Acceso a notificaciones**: concédelo a MacroDroid.
3. **Acción** ＋ → *Conectividad* → **Solicitud HTTP**:
   - Método **POST**, URL `https://ez-finance.example.com/api/ingest`.
   - Pestaña *Encabezados*: nombre `Authorization`, valor `Bearer ` + tu token (con el espacio).
   - Pestaña *Contenido*: tipo `application/json`, texto
     `{"source":"android","text":"[app_name] [hour]:[minute] [notification_title] [notification]"}` (los corchetes
     son texto mágico de MacroDroid: insértalos con el botón `...` para no escribirlos mal). El nombre de la app
     distingue DeUna de Pichincha, y la hora evita que dos pagos iguales del mismo día se descarten como el mismo
     aviso (los push de DeUna no traen hora y `/api/ingest` deduplica por texto).
   - Opcional: guarda el **código de respuesta** en una variable y agrega una acción *Mostrar aviso (toast)* con
     ella. `202` = llegó; `401` = token mal copiado; `400` = el cuerpo no es JSON válido.
4. Guarda la macro (✓) y déjala activa.
5. Ajustes de Android → Aplicaciones → MacroDroid → Batería → **Sin restricciones** (en Xiaomi/Samsung también
   *Inicio automático*). Si no, el sistema la duerme y se pierden avisos.
6. Prueba: cuando te llegue un ingreso (o pide $1 a alguien) debe aparecer en `/inbox` en ~30 s.

- El push no dice a qué cuenta entró: el ingreso cae en tu cuenta por defecto. Si fue a otra, cámbiala en `/inbox`.
- Dos ingresos del mismo monto en ±1 día se marcan como posible duplicado; revisa el nombre antes de descartar
  (dos personas pueden pagarte lo mismo el mismo día).
- El SMS de DeUna ("DEUNA!: … Recibiste …") no llega siempre; no se usa.
- Crea las categorías de ingresos que uses ("Sueldo", "Reembolsos"…): cuando confirmas un pagador con categoría,
  los siguientes avisos de esa persona o empresa la toman solos.
- Si un aviso nunca llega a `/inbox`, el estado de cuenta del mes lo delata: una diferencia de más de $5 aparece
  en la bandeja (en la tarjeta, el cargo que falte llega como pendiente).

## 3. iPhone (Atajos)

Solo iOS 27 o superior (antes iOS no dejaba leer notificaciones de otras apps). Pasos en `/settings`:
automatización **Notificación** → apps Banco Pichincha y DeUna, sin filtro de mensaje → **Ejecutar inmediatamente** → *Obtener contenido de URL* POST con
`Authorization` y cuerpo JSON `source: ios`, `text: <Notificación>`. El servidor no distingue `ios` de `android`.

Sin verificar en un iPhone real: que el disparador permita ejecutar sin confirmación y que el push de iOS traiga
el mismo texto que el de Android. Probarlo con el primer piloto de iPhone (un ingreso de $1 debe llegar a `/inbox`).

## Parser (GitHub Actions)

Secrets del repo (`gh secret set NOMBRE`):

| Secret | Valor |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | salida de `claude setup-token` (usa tu suscripción de Claude) |
| `SUPABASE_URL` | `https://your-project-ref.supabase.co` |
| `SUPABASE_SECRET_KEY` | service role / secret key del proyecto |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | claves de las notificaciones push (ver abajo); sin ellas el parser no avisa |

En Vercel, `GITHUB_DISPATCH_TOKEN` (PAT fine-grained con Actions: write sobre el repo) hace que `/api/ingest`
dispare el workflow al instante; sin él, los avisos esperan al cron horario.

Correr a mano: `gh workflow run parse-pending`. Localmente en Windows:
`CLAUDE_BIN=<ruta a claude.exe> SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/parse-pending.ts`.

> GitHub desactiva los `schedule` tras 60 días sin commits en el repo; si deja de correr, reactívalo en la pestaña Actions.

## Notificaciones push (Android, iPhone, escritorio)

Al terminar cada corrida, el parser manda **una** notificación por usuario con lo que entró a su bandeja
(`inboxNotice()` en `src/lib/push.ts`; tocarla abre `/inbox`; el ícono de la app muestra el número de pendientes).
Solo se avisa lo que llega por **correo** (y los cargos o revisiones de estados de cuenta): lo del celular ya lo
avisó el banco en ese teléfono y la bandeja lo retiene 8 min esperando el correo.

- **Claves (una vez)**: `npx web-push generate-vapid-keys`. La pública va en Vercel como `PUBLIC_VAPID_PUBLIC_KEY`
  y en el repo como `VAPID_PUBLIC_KEY`; la privada en Vercel como `VAPID_PRIVATE_KEY` y en el repo con el mismo
  nombre (`gh secret set …`, sin pegarlas en la terminal). Regenerarlas invalida todas las suscripciones: cada
  dispositivo debe volver a activarlas en `/settings`.
- **Activar**: `/settings` → notificaciones → **activar en este dispositivo** (pide permiso) → **enviar prueba**.
  La suscripción queda en `push_subscriptions` (una fila por navegador; las que el servicio push da por muertas,
  404/410, se borran solas al enviar).
- **Android**: Chrome, Edge, Samsung Internet o Firefox, con o sin instalar la app (menú → *Instalar app* /
  *Añadir a pantalla de inicio*).
- **iPhone / iPad**: solo con la app en la pantalla de inicio (iOS/iPadOS 16.4+): Safari → Compartir →
  *Añadir a pantalla de inicio* → abrir desde el ícono → `/settings` → activar. Dentro de Safari no existe la API;
  `/settings` lo explica. El mensaje va en formato *Declarative Web Push* (`web_push: 8030`): iOS 18.4+ lo
  muestra sin despertar al service worker; versiones anteriores y Chrome lo pasan a `public/sw.js`, que muestra lo mismo.
  La app instalada tiene sus propias cookies: hay que ingresar de nuevo dentro de ella.
- `public/manifest.webmanifest` + íconos (`icon-*.png`, `apple-touch-icon.png`, `badge-96.png` monocromo para la
  barra de Android) hacen la app instalable; el Layout registra `/sw.js` en todas las páginas.
- El contenido viaja cifrado de punta a punta (Google/Apple no lo leen), pero se ve en la pantalla bloqueada
  igual que el aviso del banco. Los fallos de envío quedan en `reports` (`context.step = 'push'`), nunca frenan al parser.

## Privacidad (pendiente para cuando deje de ser piloto)

Hoy es uso personal; antes de abrirlo a otros usuarios hay que resolver:

- **Permisos del teléfono**: MacroDroid/Atajos ven todas las notificaciones y el token de captura vive en
  texto plano en el teléfono. Mitigación actual: regenerar el token en `/settings` lo revoca.
- **Datos de terceros**: los avisos de ingresos traen el nombre de quien paga (y otros bancos, su cuenta). Se guardan crudos en
  `ingest_events.raw` y viajan a Claude. Falta: borrar o recortar el crudo tras parsearlo y enmascarar números de
  cuenta antes del prompt.
- **Intermediarios**: los push pasan por Google/Apple y por la app de automatización; cada usuario autoriza su
  propio dispositivo, y `/settings` debería explicarlo.
- **Logs**: el Action no imprime texto ni montos; mantenerlo así.
