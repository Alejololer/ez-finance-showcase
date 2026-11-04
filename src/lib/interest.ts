// Interés diario de cuentas de ahorro (Ahorro Flexible: tasa anual acreditada cada día sobre el saldo).
// Módulo puro: fechas "YYYY-MM-DD", montos en cents con signo.

const DAY = 86_400_000;
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);

// $3487.40 al 4.75 % → round(348740 × 4.75 / 36500) = 45 → $0.45, igual que el banco.
export const dailyInterest = (balanceCents: number, ratePct: number) =>
  balanceCents > 0 ? Math.round((balanceCents * ratePct) / 36500) : 0;

// Interés de cada día de `from` a `to` sobre el saldo al cierre del día. Compuesto: el interés de un día suma al
// saldo del siguiente. `opening` = saldo antes de `from`; `txs` = movimientos confirmados desde `from`.
export function interestRows(opening: number, txs: { date: string; amount_cents: number }[], ratePct: number, from: string, to: string) {
  let balance = opening;
  const rows: { date: string; cents: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    balance += txs.filter((t) => t.date === d).reduce((s, t) => s + t.amount_cents, 0);
    const cents = dailyInterest(balance, ratePct);
    if (cents) rows.push({ date: d, cents });
    balance += cents;
  }
  return rows;
}
