// Google Apps Script: envía a ez-finance los correos con el label "ez-finance" y les quita el label.
// Plantilla para copiar (setup en docs/captura.md): pega tu token abajo y ejecuta install una vez.
// Los PDF adjuntos (estados de cuenta) se convierten a texto con el servicio avanzado Drive API (v3);
// los filtros se crean con el servicio avanzado Gmail. Ambos vienen activados en appsscript.json.
const INGEST_TOKEN = 'PEGA_AQUI_TU_TOKEN'; // de ez-finance → ajustes → generar token
const INGEST_URL = 'https://ez-finance.example.com/api/ingest';
const LABEL = 'ez-finance';
const MAX_BYTES = 14000; // el servidor acepta 16 KB; margen para el escapado JSON
// Remitentes de avisos que van al label. install() crea los que falten.
const FILTERS = [
  { from: 'banco@pichincha.com' },
  { from: 'notificaciones@infopacificard.com.ec' },
  { from: 'documentoselectronicos@pichincha.com', subject: 'ESTADO CUENTA' },
  { from: 'estadodecuenta@pacificard.ec', subject: 'Estado de Cuenta' },
];
const STATEMENTS = '(from:documentoselectronicos@pichincha.com subject:"ESTADO CUENTA") OR from:estadodecuenta@pacificard.ec';

// Instalaciones viejas guardaban el token en Propiedades del script.
function token() {
  const t = INGEST_TOKEN.startsWith('PEGA') ? PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN') : INGEST_TOKEN;
  if (!t) throw new Error('Pega tu token en INGEST_TOKEN (línea 5) y vuelve a ejecutar');
  return t.trim();
}

function run() {
  const t = token();
  const label = GmailApp.getUserLabelByName(LABEL);
  if (!label) throw new Error('Falta el label ' + LABEL + ': ejecuta install');

  for (const thread of label.getThreads(0, 20)) {
    let ok = true;
    // Reenviar mensajes viejos del hilo es inocuo: el servidor descarta duplicados exactos.
    for (const m of thread.getMessages()) {
      const res = UrlFetchApp.fetch(INGEST_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + t },
        payload: payloadOf(m),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code === 202) continue;
      console.error(code, res.getContentText());
      // 400/413 no se arreglan reintentando (el hilo se reenviaría cada 5 min para siempre); 401, 429 y 5xx sí.
      if (code === 401 || code === 429 || code >= 500) ok = false;
    }
    if (ok) thread.removeLabel(label); // si falló, queda con label y se reintenta en 5 min
  }
}

// Asunto + cuerpo + texto de los PDF, recortado por la cola si aun así no cabe.
function payloadOf(m) {
  const pdf = pdfText(m);
  let text = (m.getSubject() + '\n' + m.getPlainBody() + (pdf ? '\n--- PDF adjunto ---\n' + pdf : '')).slice(0, 16000);
  const make = () => JSON.stringify({ source: 'email', text: text, received_at: m.getDate().toISOString() });
  while (Utilities.newBlob(make()).getBytes().length > MAX_BYTES) text = text.slice(0, Math.floor(text.length * 0.9));
  return make();
}

function pdfText(m) {
  return m.getAttachments()
    .filter((a) => /\.pdf$/i.test(a.getName()))
    .map((a) => {
      // Pichincha manda el PDF como application/octet-stream: sin el tipo correcto Drive no lo convierte.
      const blob = a.copyBlob().setContentType('application/pdf');
      const file = Drive.Files.create({ name: a.getName(), mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'es' });
      try {
        const text = DocumentApp.openById(file.id).getBody().getText();
        // PacifiCard: la página 1 (resumen y detalle, pocas líneas) para cruzar cada cargo con la app.
        // Pichincha: solo el resumen; su detalle no hace falta (la app ya lo tiene) y pesa decenas de KB.
        return /pacificard/i.test(m.getFrom()) ? text.split(/CONCEPTOS B[ÁA]SICOS/)[0] : text.split('DETALLE DE MOVIMIENTOS')[0];
      } finally {
        Drive.Files.remove(file.id);
      }
    })
    .join('\n');
}

// Ejecutar una sola vez a mano: crea label y filtros (si faltan) y programa run() cada 5 minutos.
// Se puede repetir sin duplicar nada.
function install() {
  token(); // falla antes de pedir nada si no se pegó el token
  const labels = (Gmail.Users.Labels.list('me') || {}).labels || [];
  const labelId = (labels.find((l) => l.name === LABEL) || Gmail.Users.Labels.create({ name: LABEL }, 'me')).id;

  const key = (c) => (c.from || '') + '|' + (c.subject || '');
  // Una cuenta sin filtros devuelve null, no {}.
  const existing = ((Gmail.Users.Settings.Filters.list('me') || {}).filter || []).map((f) => key(f.criteria || {}));
  for (const criteria of FILTERS) {
    if (!existing.includes(key(criteria))) {
      Gmail.Users.Settings.Filters.create({ criteria: criteria, action: { addLabelIds: [labelId] } }, 'me');
    }
  }

  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  console.log('Listo: los avisos nuevos de tu banco llegarán a ez-finance.');
}

// Prueba: muestra en el registro lo que se enviaría por los últimos estados de cuenta (no envía nada).
function pdfPreview() {
  for (const t of GmailApp.search(STATEMENTS, 0, 3)) {
    const p = payloadOf(t.getMessages()[0]);
    console.log(Utilities.newBlob(p).getBytes().length + ' bytes\n' + JSON.parse(p).text);
  }
}
