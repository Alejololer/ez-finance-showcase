import { describe, expect, it } from 'vitest';
import { dailyInterest, interestRows } from './interest';

describe('interés diario', () => {
  it('caso real del Ahorro Flexible: $3487.40 al 4.75 % → $0.45', () => {
    expect(dailyInterest(348740, 4.75)).toBe(45);
    expect(dailyInterest(0, 4.75)).toBe(0);
    expect(dailyInterest(-5000, 4.75)).toBe(0);
  });

  it('día a día, compuesto y con los movimientos de cada día', () => {
    const txs = [
      { date: '2026-10-01', amount_cents: 248740 },
      { date: '2026-10-03', amount_cents: -348740 }, // se vacía la cuenta: ese día ya no genera
      { date: '2026-10-09', amount_cents: 999999 }, // posterior al rango: no cuenta
    ];
    expect(interestRows(100000, txs, 4.75, '2026-10-01', '2026-10-03')).toEqual([
      { date: '2026-10-01', cents: 45 },
      { date: '2026-10-02', cents: 45 }, // 348785 → 45.39
    ]);
  });
});
