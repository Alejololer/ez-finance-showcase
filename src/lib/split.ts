// Cuenta común "mixta": cada persona pone el mismo % de su ingreso (lo acuerdan ellas) cada mes, hasta un día límite.
import { dayOf } from './card.ts';

// Aporte de cada persona en cents.
export const split = (pct: number, incomes: number[]) => incomes.map((cents) => Math.round((cents * pct) / 100));

// % de los ingresos que cubre justo el gasto común, con un decimal. null sin ingresos.
export const fairPct = (expense: number, incomes: number[]) => {
  const total = incomes.reduce((s, c) => s + c, 0);
  return total > 0 ? Math.round((expense / total) * 1000) / 10 : null;
};

export type Contribution = {
  dueDate: string; // próximo vencimiento (hoy incluido)
  base: string; // mes del ingreso que define el aporte ("YYYY-MM-01")
  income: number;
  due: number; // aporte de este ciclo
  arrears: number; // lo que faltó del ciclo anterior
  paid: number; // depósitos desde el vencimiento anterior
  left: number;
  overdue: boolean; // los depósitos aún no cubren lo atrasado
  daysLeft: number;
};

// Como el pago de la tarjeta: el aporte que vence el día `dueDay` del mes M es pct × ingreso del mes M-1 (completo
// para entonces) y lo cubren los depósitos posteriores al vencimiento anterior. Lo que faltó al vencer se arrastra
// al ciclo siguiente y queda vencido hasta cubrirse. `incomes` por mes ("YYYY-MM-01" → cents); `since` = inicio de
// la cuenta común (un ciclo que venció antes no se cobra).
// ponytail: arrastre de un solo ciclo; un libro desde `since` si se acumulan meses impagos.
export function contribution(
  pct: number, dueDay: number, today: string, since: string,
  incomes: Record<string, number>, deposits: { date: string; amount_cents: number }[],
): Contribution {
  const [y, m] = today.split('-').map(Number);
  const dueOf = (k: number) => dayOf(y, k, dueDay); // vencimiento del mes k (0-based, puede desbordar)
  const incomeOf = (k: number) => incomes[dayOf(y, k - 1, 1)] ?? 0;
  const paidIn = (from: string, to: string) =>
    deposits.filter((d) => d.date > from && d.date <= to).reduce((s, d) => s + d.amount_cents, 0);
  let k = m - 1;
  if (dueOf(k) < today) k++;
  const [due] = split(pct, [incomeOf(k)]);
  const prevDue = dueOf(k - 1) >= since ? split(pct, [incomeOf(k - 1)])[0] : 0;
  const arrears = Math.max(0, prevDue - paidIn(dueOf(k - 2), dueOf(k - 1)));
  const paid = paidIn(dueOf(k - 1), '9999-12-31');
  return {
    dueDate: dueOf(k), base: dayOf(y, k - 1, 1), income: incomeOf(k), due, arrears, paid,
    left: Math.max(0, due + arrears - paid), overdue: paid < arrears,
    daysLeft: Math.round((Date.parse(dueOf(k)) - Date.parse(today)) / 86_400_000),
  };
}
