---
paths:
  - "src/**/*.astro"
  - "src/styles/**"
  - "src/components/**"
---

# UI

## Identidad visual ("statue hall", del prototipo de alejololer.is-a.dev)

- Negro profundo (`bg #050505`), sin cajas ni barras: líneas finas (`border-line`), mucho aire y una escultura
  1-bit tramada (Bayer) de fondo, `components/Sculpture.astro` (WebGL propio, sin three.js). El puntero es su luz.
- Tipografía: **Fraunces** (serif liviana, cursiva para el énfasis) en titulares, nombres y saldos grandes
  (`.display`, `.money-hero`); **Inter Tight** en interfaz, meta y montos de lista (`.money`, con `tabular-nums`).
  Eyebrows y etiquetas en mayúsculas con tracking amplio (`.prompt`, `.label`, `.win-bar`).
- Cada página: `<Layout title em? path flash sculpture?>`. `path` es el eyebrow (el Layout antepone el número romano
  de la sección); `em` es la segunda línea del titular, en cursiva. `sculpture="hero"` solo en inicio y login;
  el resto usa `dim` (atenuada, a la derecha). En celular (fuera de la disposición ancha) va más chica en la esquina
  superior derecha junto al titular, anclada al scroll (se va con el encabezado): detrás del contenido solo asomaba en
  franjas entre superficies. Hero plena, dim atenuada, igual que en escritorio.
- Navegación: λ + secciones con números romanos arriba (`mix-blend-difference`); en celular un `popover` a pantalla
  completa con filas grandes. Sin barras tipo tmux ni barra inferior. Atajos de teclado 0-4 siguen activos.
- Navegación: la pestaña activa **no cambia de fuente ni de tamaño** (misma sans en mayúsculas, se marca con
  subrayado); cualquier cambio de ancho reacomoda el nav al navegar. En el menú del celular, lo mismo: subrayado
  y las demás atenuadas (no cursiva: no se lee como "activa"). Un fundido (`from-bg`) va detrás del nav
  para que el contenido que pasa por debajo no choque con λ.
- Contenedores: `.win > .win-bar + .win-body` (sección con línea superior y eyebrow, sin chrome de ventana), `.box`
  (borde fino con blur) y `.row` (fila de lista: `.n` + título serif + dato; hover desplazado solo si es `a.row`).
- **Un estilo por rol** (congruencia entre páginas): nombre de ítem en fila o ventana = `.item`; monto de lista =
  `.money text-xl`; `.money-hero` solo para la cifra protagonista de un bloque (total de inicio, saldo de cada
  cuenta); encabezado de sección o grupo = `.prompt` o `.win-bar` (sobre un grupo de filas, `.prompt.head`); aviso amarillo = `.notice`. No inventar tamaños.
  Plegables: `<details class="win"><summary class="win-bar">nombre</summary>`. Etiquetas en español natural
  (`nuevo movimiento`), no nombres de archivo.
- Color **solo** en montos y avisos, apagado: gasto `text-neg`, ingreso `text-pos`, advertencia `text-warn`.
  Transferencias y ajustes en `text-fg`. Modo "vapor" (escribir `vapor`) tiñe la trama y los acentos.
- Barras de proporción con `.dither` (relleno tramado de 1 px), no con caracteres de bloque.
- Tokens en `@theme` de `src/styles/global.css`; clases: `.display .prompt .head .box .win .win-bar .win-body .btn
  .btn-ghost .input .label .error .flash .toast .confirm .meta .item .notice .money .money-hero .row .dither
  .marquee .rise .lens`. Botones con `whitespace-nowrap` (nunca se parten en dos líneas).
  No usar colores slate/gray sueltos.
- Dinero siempre con `formatMoney` (es-US → `$8,404.01`, igual que los avisos del banco).

## Navegación y movimiento

- **`<ClientRouter />` en el Layout**: navegar y enviar forms (GET y POST) no recarga el documento. Sin él, Firefox
  (sin view transitions entre documentos) muestra su lienzo gris en cada cambio. Consecuencias:
  - Los scripts inline del Layout y de `Sculpture.astro` corren **una sola vez**; lo que dependa de la página va en
    `astro:after-swap` (el router reemplaza los atributos de `<html>`: ahí se reponen `vapor` y `nav`) o se lee del
    DOM en cada uso (la escultura lee `body.dataset` en cada cuadro). Listeners en `document`/`window`, una vez.
  - Canvas de la escultura y `.lens` llevan `transition:persist` (WebGL y lente siguen vivos entre páginas).
  - Un form cuya respuesta redirige a otro origen lleva `data-astro-reload` (login con Google).
- Respaldo para recargas completas (F5, Google): `<meta name="color-scheme" content="dark">` + fondo en `<style>`
  inline (sin lienzo blanco antes del CSS), `@view-transition { navigation: auto }`, `scrollbar-gutter: stable`,
  y la escultura/lente guardan su estado en `sessionStorage` (`pagehide`) para no reiniciarse de golpe.
- **Nada lleva `view-transition-name`**: el canvas opaco taparía el contenido durante el fundido y el nav aislado
  pierde su `mix-blend-difference`. Solo el fundido de `root`.
- Tras un POST la página vuelve **a la misma altura** (el Layout guarda `scrollY` en `submit` y lo restaura): en la
  bandeja el ítem siguiente ocupa el lugar del confirmado. No usar anclas `#siguiente` (el fundido mezcla dos alturas).
- `.rise` solo en titulares y hero, y solo al llegar al sitio (`html.nav` lo apaga al navegar dentro). **Nunca** en
  filas, `.flash` ni `.error`: aparecen tras un POST y deben verse de inmediato.
- Popovers y plegables abren con fundido/altura (`@starting-style`, `::details-content`); dentro de un popover
  vuelve el cursor nativo (la capa superior queda encima del lente).
- `cursor: none` solo con puntero fino y **nunca** en `input/select/textarea` (pierden el caret); el lente
  (`.lens`) va **1:1** con el puntero (sin suavizado: es el cursor), crece sobre `a, button, summary` y se oculta sobre los campos.
- **Rendimiento** (medido en laptop Intel Arc, 2880 px a 120 Hz, Firefox: 76 % → 43 % de GPU): la escultura
  se dibuja a **60 fps** (tic `Math.round(ts * 0.06)`). Las constantes de la escultura son por cuadro de 120 Hz (como se calibró) y `frame(n)` las escala con los pasos transcurridos: no depende de los fps. En la disposición ancha (`(min-width: 761px) and (min-aspect-ratio: 4/3)`, la misma media query en
  `Sculpture.astro` y `global.css`: si difieren, la escultura y las superficies se contradicen) las páginas `dim`
  no llevan `backdrop-filter` en `.box/.win/.row/.head` (la escultura no queda detrás y el blur se recalculaba en cada
  cuadro). No agregar `backdrop-filter` sobre superficies grandes que queden encima del canvas animado.
  Fuera de cuadro (en celular, al bajar del encabezado) la escultura **no se dibuja**: un test de frustum contra la cota
  `3.6 × escala` del shader deja el último cuadro (vacío) y el blur de las superficies deja de recalcularse
  (SwiftShader, celular emulado: 3.7 % → 0.1 % de CPU y rAF de ~30 a 60 fps). Si cambia la cámara, el fov o esa cota, actualizar el test.
- Escultura lisa: ruido con interpolación **quíntica** (la cúbica deja pliegues rectos en la luz) y techo suave a
  `amp × freq ≤ 0.8` (más arriba gotea y se fragmenta). No subir `amp` ni `freq` sin revisar ese producto.
- `prefers-reduced-motion`: sin marquee, `.rise` ni fundidos, y la escultura dibuja un solo cuadro (y otro tras
  cada navegación y cada scroll, para seguir al encabezado en celular).

## Mobile-first (obligatorio)

- Clases base = celular; `sm:` agrega columnas. Grids arrancan en `grid-cols-1`.
- Gutter móvil `px-6` (24 px) en main, nav, menú y footer (`.bleed` lo compensa con `-mx-6`). No volver a `px-4`:
  en el Z Flip 7 el texto y los montos quedaban pegados al borde.
- En celular `.win` y `.row` van de borde a borde (`-mx-6 px-6`, `sm:` lo quita): con el fondo al 90 % dentro del
  gutter, la superficie recortaba la escultura en un rectángulo y el texto quedaba a ras de él. No darles `px-*`
  ni `pl-*` sin prefijo `sm:` (pisa el padding del borde a borde); el hover desplazado de `a.row` es solo `sm:`. En filas, nombre `min-w-0 truncate` y monto
  `shrink-0`: `html` recorta el desborde sin scroll y lo cortado se ve "pegado".
- Sin `<table>`: secciones en grid o filas `.row` (ver `/transactions`).
- Filas de botones con `flex flex-wrap gap-2`; acción principal `flex-1 sm:flex-none`.
- Pantalla externa de los plegables tipo concha (Z Flip 7, ~360×400): variante `cover:` de `global.css` (alto ≤ 520 y
  aspecto 3/4–4/3). Titular a 2.75rem, sin eyebrow ni marquee; el menú con filas más chicas y bajas (entra sin scroll).
  Con ~400 px de alto, todo lo `fixed` a pantalla completa lleva `overflow-y-auto` (menú) y los popovers un `max-h`
  (`.confirm`): si no, lo de abajo queda fuera y no se alcanza. No ocultar contenido en `cover` (el desglose del mes se queda).
- Sin scroll horizontal a 375 px (el marquee usa `.bleed` y `html` recorta el desborde).

## Heurísticas UX

- Todo botón de envío lleva `data-pending="guardando…"`: el Layout lo deshabilita y cambia el texto.
- Carga entre páginas (red lenta): en `astro:before-preparation` el Layout pone `html.loading` (barra fina arriba,
  tras 150 ms) y `aria-busy` en el enlace/botón pulsado (late). El swap los quita solos; no hace falta nada por página.
- Tras una acción exitosa, mensaje en `flash` del Layout: aviso fijo abajo (`.toast`, `role="status"`, se
  desvanece solo y no captura toques); errores inline (`.error`) junto al campo.
- En `/inbox` cada form lleva `?item=<clave>` en la acción para que el error abra y marque **solo** su ventana.
  El Layout borra `_action` e `item` de la URL tras cada envío (`history.replaceState`): F5 es un GET a la página
  limpia y nunca reenvía la acción, con router o sin él. El servidor solo lee `item` durante el POST.
- Destructivos con `<Confirm>` (`components/Confirm.astro`: popover propio dentro del form, "sí, …" + "cancelar",
  `formnovalidate`), nunca `confirm()` del navegador.
- Estados vacíos con texto explicativo (frase en serif cursiva si es el mensaje principal).
- Select con una sola opción → `<input type="hidden">`, no un select deshabilitado.
- En `/inbox` la acción principal (confirmar/descartar) va a la vista; los campos, dentro de "editar".
- Avisos del celular de menos de 8 min (`held()`) no se muestran ni se cuentan: solo una línea `.meta` "N aviso(s)
  del celular espera(n) el correo del banco…". Cualquier lista nueva de pendientes debe respetar `held()`.
- Con `sculpture="hero"` (login) un bloque con texto va en `.box` (borde y padding), no en `.win`: sobre la
  escultura plena, `.win` se ve como un rectángulo negro con el texto a ras de su borde.
- Sobre la trama, el texto va en superficies con fondo al 90 % y blur (`.win`, `.box`, `.row`, `.head`; un grupo
  de filas va seguido, sin gap, con el espacio dentro de `.head` (ver `/transactions`); sin blur en la disposición ancha de `dim`, ver Rendimiento): `dim` (#9a9a9a) queda en 5.9:1 en el peor caso. Estados atenuados (pendiente) con `opacity-75` como mínimo (AA).
