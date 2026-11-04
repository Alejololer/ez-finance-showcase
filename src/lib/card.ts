// Ciclo de facturación de tarjetas de crédito. Módulo puro: fechas "YYYY-MM-DD", montos en cents con signo
// (en la tarjeta un consumo es negativo y un pago positivo; saldo negativo = deuda).

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
// Día `day` del mes `month` (0-based, puede desbordar a otro año), recortado a fin de mes: corte 31 en febrero → 28/29.
export const dayOf = (year: number, month: number, day: number) => {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(day, last)));
};

// Sábado/domingo → día hábil más cercano hacia `dir` (-1 antes, +1 después).
// ponytail: solo fines de semana; feriados de Ecuador si un corte vuelve a no cuadrar.
const workday = (d: string, dir: 1 | -1) => {
  let t = Date.parse(d);
  while ([0, 6].includes(new Date(t).getUTCDay())) t += dir * DAY;
  return iso(t);
};

export type Cycle = { lastClose: string; nextClose: string; dueDate: string };

// El banco adelanta el corte que cae en fin de semana al viernes (corte 24 en sábado → 23) y pasa el pago al lunes.
export function cycle(statementDay: number, dueDay: number, today: string): Cycle {
  const [y, m] = today.split('-').map(Number);
  const close = (k: number) => workday(dayOf(y, k, statementDay), -1); // corte del mes k (0-based, puede desbordar)
  let k = m - 1;
  if (close(k) > today) k--;
  else if (close(k + 1) <= today) k++; // corte del mes siguiente adelantado a este (día 1 en domingo → viernes 30)
  // Fecha límite: el primer día de pago posterior al corte nominal (mismo mes o el siguiente).
  let due = dayOf(y, k, dueDay);
  if (due <= dayOf(y, k, statementDay)) due = dayOf(y, k + 1, dueDay);
  return { lastClose: close(k), nextClose: close(k + 1), dueDate: workday(due, 1) };
}

// Desgravamen por tramos de deuda: [{ upto: 3500000, cents: 500 }, …] = hasta $35,000 → $5. `upto: null` = sin tope
// (monto fijo). Deuda por encima del último tope → el último monto.
export type Tier = { upto: number | null; cents: number };

const cents = (s: string) => (/^\d+([.,]\d{1,2})?$/.test(s) ? Math.round(Number(s.replace(',', '.')) * 100) : NaN);

// "5" → fijo; "35000: 5, 50000: 6.50, 80000: 7" → tramos (tope: monto). null si no se entiende.
export function parseTiers(s: string): Tier[] | null {
  const t = s.trim();
  if (!t.includes(':')) return cents(t) > 0 ? [{ upto: null, cents: cents(t) }] : null;
  const tiers = t.split(/[;,\n]\s*(?=\d+(?:[.,]\d{1,2})?\s*:)/).map((p) => {
    const [upto, fee] = p.split(':').map((x) => x.trim());
    return { upto: cents(upto), cents: cents(fee) };
  });
  const ok = tiers.every((x, i) => x.upto > 0 && x.cents > 0 && (i === 0 || x.upto > tiers[i - 1].upto!));
  return ok ? tiers : null;
}

export const formatTiers = (tiers: Tier[]) =>
  tiers.map((x) => (x.upto === null ? '' : `${x.upto / 100}: `) + (x.cents / 100).toFixed(2)).join(', ');

export const tierFee = (tiers: Tier[], debt: number) => (tiers.find((x) => x.upto === null || debt <= x.upto) ?? tiers.at(-1)!).cents;

// Cargos que el banco suma al corte: desgravamen (según la deuda, solo si hay) y costo anual (en su mes).
// `balanceAtClose` = saldo confirmado al cierre del corte (negativo = deuda).
export function cardFees(
  card: { monthly_fee_tiers: Tier[] | null; annual_fee_cents: number | null; annual_fee_month: number | null },
  close: string,
  balanceAtClose: number,
) {
  const fees: { cents: number; merchant: string; reference: string }[] = [];
  if (card.monthly_fee_tiers?.length && balanceAtClose < 0)
    fees.push({ cents: tierFee(card.monthly_fee_tiers, -balanceAtClose), merchant: 'Desgravamen', reference: `DESG-${close.replaceAll('-', '')}` });
  if (card.annual_fee_cents && Number(close.slice(5, 7)) === card.annual_fee_month)
    fees.push({ cents: card.annual_fee_cents, merchant: 'Costo anual', reference: `ANUAL-${close.slice(0, 4)}` });
  return fees;
}

export type CardStatus = {
  statement: number; // lo facturado al último corte (incluye lo que quedó impago antes)
  paid: number; // pagos y devoluciones después del corte
  due: number; // lo que falta pagar del corte
  cycleSpent: number; // consumos del ciclo en curso
  overdue: boolean;
  daysLeft: number; // días hasta la fecha límite (negativo si ya pasó)
};

export function cardStatus(
  txs: { date: string; amount_cents: number; kind: string }[], // solo confirmados de la tarjeta
  c: Cycle,
  today: string,
  billed?: number, // lo que el banco facturó al corte (cents); manda sobre el cálculo, que incluye compras aún en tránsito
): CardStatus {
  let atClose = 0, paid = 0, cycleSpent = 0;
  for (const t of txs) {
    if (t.date <= c.lastClose) atClose += t.amount_cents;
    else if (t.amount_cents > 0) paid += t.amount_cents;
    else if (t.kind === 'expense') cycleSpent -= t.amount_cents;
  }
  const statement = billed ?? Math.max(0, -atClose);
  const due = Math.max(0, statement - paid);
  const daysLeft = Math.round((Date.parse(c.dueDate) - Date.parse(today)) / DAY);
  return { statement, paid, due, cycleSpent, overdue: due > 0 && daysLeft < 0, daysLeft };
}
