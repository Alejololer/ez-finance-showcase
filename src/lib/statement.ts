// Estados de cuenta leídos sin LLM (formato fijo; mandarlos a Claude sería caro).
// Pichincha: el correo trae "Cuenta: 2200029306" y "Estado de cuenta del mes: 21-08-2026" (corte); el PDF adjunto,
// convertido a texto por clients/gmail.gs, trae la conciliación:
// "SALDO ANTERIOR 7.09 DEPÓSITO / CRÉDITOS (100) 7463.77 CHEQUES / DÉBITOS (154) 7215.15 INTERÉS PERIODO 0.00 SALDO ACTUAL 255.71"
// (el número entre paréntesis es la cantidad de movimientos). La cuenta sale del correo, no del PDF: el detalle
// de movimientos menciona otras cuentas.
// PacifiCard: ver parseCardStatement abajo.
import type { Account } from './parse.ts';

// Línea del detalle de una tarjeta, con el signo de la app: cargo negativo, pago o crédito positivo.
export type Line = { date: string; description: string; cents: number };

export type StatementDecision =
  // Solo tarjetas: `due_date` = fecha máxima de pago; `lines` null = el detalle del PDF no se pudo leer (el total vale igual).
  | { status: 'statement'; account_id: number; date: string; balance_cents: number; due_date?: string; lines?: Line[] | null }
  | { status: 'review'; error: string };

const DAY = 86_400_000;
const toCents = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
const cents = (re: RegExp, text: string) => {
  const m = text.match(re)?.[1];
  return m === undefined ? null : toCents(m);
};
const AMOUNT = String.raw`(-?[\d,]*\d\.\d{2})`;
const review = (error: string) => ({ status: 'review' as const, error: `Estado de cuenta: ${error}` });
const inRange = (date: string, receivedAt: string) => {
  const age = +new Date(receivedAt) - Date.parse(date + 'T12:00:00Z');
  return age >= -DAY && age <= 45 * DAY;
};

// null = no es un estado de cuenta (lo interpreta Claude como cualquier aviso).
export function parseStatement(text: string, accounts: Account[], receivedAt: string): StatementDecision | null {
  if (/Estado de Cuenta PacifiCard/i.test(text)) return parseCardStatement(text, accounts, receivedAt);
  const cut = text.match(/Estado de cuenta del mes:\W*(\d{2})-(\d{2})-(\d{4})/);
  if (!cut) return null;

  const number = text.match(/Cuenta:\W*(\d{6,})/)?.[1];
  if (!number) return review('no se encontró el número de cuenta');
  const opening = cents(new RegExp(`SALDO ANTERIOR\\s+${AMOUNT}`), text);
  const credits = cents(new RegExp(`CR[ÉE]DITOS\\s*\\(\\d+\\)\\s*${AMOUNT}`), text);
  const debits = cents(new RegExp(`D[ÉE]BITOS\\s*\\(\\d+\\)\\s*${AMOUNT}`), text);
  const interest = cents(new RegExp(`INTER[ÉE]S PERIODO\\s+${AMOUNT}`), text) ?? 0;
  const closing = cents(new RegExp(`SALDO ACTUAL\\s+${AMOUNT}`), text);
  if (opening === null || credits === null || debits === null || closing === null) {
    return review('no se pudo leer el saldo del PDF adjunto');
  }
  // La conciliación del propio banco valida la lectura (con o sin el interés sumado aparte).
  const sum = opening + credits - debits;
  if (sum !== closing && sum + interest !== closing) return review('los saldos del PDF no cuadran');

  const account = accounts.find((a) => a.last4?.split(',').some((n) => number.endsWith(n)));
  if (!account) return review(`la cuenta ··${number.slice(-4)} no está registrada`);
  if (account.type === 'credit' || account.currency !== 'USD') return review(`${account.name} no se concilia sola`);

  const date = `${cut[3]}-${cut[2]}-${cut[1]}`;
  if (!inRange(date, receivedAt)) return review('fecha de corte fuera de rango');
  return { status: 'statement', account_id: account.id, date, balance_cents: closing };
}

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const month = (m: string) => (m === 'SET' ? 9 : MONTHS.indexOf(m) + 1);
const ROW = new RegExp(String.raw`(${MONTHS.join('|')}|SET)\/(\d{2})\s+\d+\s+([^\n]+)`, 'g');

// PacifiCard (Banco del Pacífico). En una tarjeta el banco cobra lo que ya procesó, no lo comprado hasta el corte:
// la fila de `statements` guarda el "Pago de Contado" (como deuda negativa), no el saldo. Del cuerpo del correo:
// "5422-58XX-XXXX-X458 · Fecha de corte | Fecha Máxima de Pago … 23/OCT/2026 | 09/NOV/2026 · Pago de Contado | $ 13.06".
// Del PDF (imagen → OCR de Drive), el detalle. El OCR separa las columnas: primero fecha y descripción de cada fila
// ("OCT/22 ⏎ 012074 GOOGLE Apple Music"), después las etiquetas del resumen (TOTAL PAGO DE CONTADO … INTERÉS POR
// MORA) y recién ahí tipos y montos mezclados ("CONS ⏎ 5.03 ⏎ MOUNTAIN MOUNTAIN ⏎ CONS ⏎ N/D ⏎ 6.99 ⏎ 1.04 ⏎ 6.99 + ⏎ 13.06 …").
function parseCardStatement(text: string, accounts: Account[], receivedAt: string): StatementDecision {
  const [body, pdf] = text.split('--- PDF adjunto ---');
  const number = body.match(/[\dX]{4}-[\dX]{4}-[\dX]{4}-X*(\d{3,4})\b/)?.[1];
  if (!number) return review('no se encontró el número de la tarjeta');
  // Las dos primeras fechas tras "Fecha de corte": el corte y la fecha máxima de pago.
  const [cut, pay] = body.slice(body.search(/Fecha de corte/i)).matchAll(/(\d{2})\/([A-Z]{3})\/(\d{4})/g);
  const iso = (d: RegExpMatchArray) => `${d[3]}-${String(month(d[2])).padStart(2, '0')}-${d[1]}`;
  const due = cents(new RegExp(`Pago de Contado\\W*${AMOUNT}`, 'i'), body);
  if (!cut || !pay || !month(cut[2]) || !month(pay[2]) || due === null) {
    return review('no se pudo leer el corte, la fecha de pago o el pago de contado del correo');
  }

  const account = accounts.find((a) => a.type === 'credit' && a.last4?.split(',').some((n) => number.endsWith(n)));
  if (!account) return review(`la tarjeta ··${number} no está registrada`);
  const date = iso(cut);
  if (!inRange(date, receivedAt)) return review('fecha de corte fuera de rango');
  const due_date = iso(pay);
  if (due_date <= date) return review('la fecha de pago no es posterior al corte');
  return { status: 'statement', account_id: account.id, date, balance_cents: -due, due_date, lines: pdf ? cardLines(pdf, date, due) : null };
}

// Fila N = N-ésima fecha/descripción + N-ésimo tipo + N-ésimo monto. Los 7 últimos montos son el resumen, en el
// orden de sus etiquetas: total de contado, saldo rotativo, saldo diferido, subtotal consumos, subtotal pagos,
// interés de financiamiento, interés por mora. Valida que el total sea el pago de contado del correo y que cargos y
// pagos sumen sus subtotales; si el OCR viene en otro orden, null (el total del correo vale igual).
function cardLines(pdf: string, cut: string, due: number): Line[] | null {
  const start = pdf.search(/DETALLE DE MOVIMIENTOS/);
  const labels = pdf.indexOf('INTERÉS POR MORA', start);
  if (start < 0 || labels < 0) return null;
  const values = pdf.slice(labels + 'INTERÉS POR MORA'.length).split(/Pago Vencido|D[óo]lares/)[0];
  const rows = [...pdf.slice(start, labels).matchAll(ROW)];
  const types = values.match(/\b(CONS|N\/D|N\/C|PAGO|INT|DIF|AV)\b/g) ?? [];
  // Montos sueltos ("5.03", "1,000.00"); el valor en moneda extranjera ("6.99 +") cae entre las filas y el resumen.
  const amounts = [...values.matchAll(/(?<![\d.,])[\d,]*\d\.\d{2}\b/g)].map((m) => toCents(m[0]));
  if (!rows.length || types.length < rows.length || amounts.length < rows.length + 7) return null;
  const [total, , , charges, credits, interest, late] = amounts.slice(-7);

  const [year, cutMonth] = cut.split('-').map(Number);
  const lines: Line[] = rows.map(([, mon, day, desc], i) => {
    const mm = month(mon);
    return {
      date: `${mm > cutMonth ? year - 1 : year}-${String(mm).padStart(2, '0')}-${day}`, // dic en el corte de enero
      description: desc.replace(/\s+/g, ' ').trim(),
      cents: ['N/C', 'PAGO'].includes(types[i]) ? amounts[i] : -amounts[i],
    };
  });
  const sum = (sign: number) => lines.reduce((s, l) => s + (Math.sign(l.cents) === sign ? Math.abs(l.cents) : 0), 0);
  if (total !== due || sum(-1) !== charges || sum(1) !== credits) return null;
  // Intereses y mora no salen como fila pero van al pago de contado: se cobran al corte.
  if (interest) lines.push({ date: cut, description: 'Interés de financiamiento', cents: -interest });
  if (late) lines.push({ date: cut, description: 'Interés por mora', cents: -late });
  return lines;
}

// Líneas del estado que no están en la app. Cada línea busca un movimiento de la tarjeta (pendiente o confirmado) del
// mismo monto, de 10 días antes a 3 después (la app anota la compra; el banco, cuando la procesa); gana el más
// cercano y cada movimiento se usa una vez.
export function missingLines(lines: Line[], txs: { id: number; date: string; amount_cents: number }[]): Line[] {
  const used = new Set<number>();
  const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;
  return lines.filter((l) => {
    const match = txs
      .filter((t) => !used.has(t.id) && t.amount_cents === l.cents && days(t.date, l.date) >= -10 && days(t.date, l.date) <= 3)
      .sort((a, b) => Math.abs(days(a.date, l.date)) - Math.abs(days(b.date, l.date)))[0];
    if (match) used.add(match.id);
    return !match;
  });
}

// Diferencia que reconcile.ts ajusta sola: intereses y redondeo.
export const MAX_AUTO = 500; // ponytail: tope fijo de $5; configurable si molesta

// El banco no siempre corta a medianoche: algo de la noche del corte puede caer en el siguiente (y al revés). Si un
// movimiento del día del corte (o del siguiente) explica la diferencia, se descuenta y queda la diferencia real.
// ponytail: un solo movimiento; si cruzan dos, buscar subconjuntos. Falso positivo posible (falta un depósito de $X y
// ese día hubo un débito de $X): el siguiente corte lo devuelve.
export function cutoffDiff(diff: number, cutDay: number[], nextDay: number[]): number {
  if (Math.abs(diff) <= MAX_AUTO) return diff;
  const fits = [...cutDay.map((c) => diff + c), ...nextDay.map((c) => diff - c)].filter((d) => Math.abs(d) <= MAX_AUTO);
  return fits.length ? fits.sort((a, b) => Math.abs(a) - Math.abs(b))[0] : diff;
}
