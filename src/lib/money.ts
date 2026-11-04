// "12.50" | "12,5" | "12" → 1250. Cualquier otra cosa → NaN (lo rechaza la validación del form).
export const toCents = (s: string) =>
  /^\d+([.,]\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s.trim().replace(',', '.')) * 100) : NaN;

export const formatMoney = (cents: number, currency = 'USD') =>
  // es-US → "$8,404.01": mismo formato que los avisos del banco y que el punto decimal de los formularios
  new Intl.NumberFormat('es-US', { style: 'currency', currency }).format(cents / 100);

// Fecha local "YYYY-MM-DD". toISOString daría la fecha UTC: después de las 19:00 en Ecuador ya es mañana.
// ponytail: zona fija, uso personal en Ecuador; columna en el perfil si algún día hay otro usuario
export const today = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

// Lo que llega del celular espera en la bandeja a que llegue el correo del mismo movimiento (el parser borra el
// pendiente del push y deja el del correo); si se mostrara ya, el usuario lo confirma antes y queda duplicado.
// ponytail: 8 min = Gmail se revisa cada 5 min + corrida del Action (peor caso medido ~5 min); subir si vuelven duplicados.
export const held = (source: string, at: string) =>
  (source === 'android' || source === 'ios') && Date.now() - Date.parse(at) < 8 * 60_000;
