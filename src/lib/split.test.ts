import { describe, expect, it } from 'vitest';
import { contribution, fairPct, split } from './split';

describe('cuenta común', () => {
  it('ejemplo: 2800 y 1600 con 1800 de gastos → 40,9 % de cada sueldo', () => {
    expect(fairPct(180000, [280000, 160000])).toBe(40.9);
    expect(split(40.9, [280000, 160000])).toEqual([114520, 65440]);
    // Con el % sin redondear el gasto queda cubierto al centavo: 1145,45 + 654,55.
    expect(split((180000 / 440000) * 100, [280000, 160000])).toEqual([114545, 65455]);
  });

  it('sin ingresos no hay % justo ni aporte', () => {
    expect(fairPct(180000, [0, 0])).toBeNull();
    expect(split(40, [0, 160000])).toEqual([0, 64000]);
  });
});

describe('aporte mensual con día límite', () => {
  const incomes = { '2026-09-01': 280000, '2026-10-01': 300000 };
  const since = '2026-09-01';

  it('pasado el día 5, el próximo vence el 5 del mes siguiente con el ingreso de este mes', () => {
    const c = contribution(40.9, 5, '2026-10-26', since, incomes, [{ date: '2026-10-03', amount_cents: 114520 }]);
    expect(c).toMatchObject({ dueDate: '2026-11-05', base: '2026-10-01', income: 300000, due: 122700, arrears: 0, paid: 0, left: 122700, overdue: false, daysLeft: 10 });
  });

  it('antes del día límite: ingreso del mes anterior y lo depositado desde el vencimiento previo', () => {
    const c = contribution(40.9, 5, '2026-10-03', since, incomes, [{ date: '2026-10-01', amount_cents: 50000 }]);
    expect(c).toMatchObject({ dueDate: '2026-10-05', base: '2026-09-01', due: 114520, paid: 50000, left: 64520, daysLeft: 2 });
  });

  it('lo que faltó al vencer se arrastra y queda vencido hasta cubrirlo', () => {
    const late = [{ date: '2026-10-20', amount_cents: 50000 }];
    expect(contribution(40.9, 5, '2026-10-26', since, incomes, late))
      .toMatchObject({ arrears: 114520, paid: 50000, left: 114520 + 122700 - 50000, overdue: true });
    const covered = [...late, { date: '2026-10-25', amount_cents: 70000 }];
    expect(contribution(40.9, 5, '2026-10-26', since, incomes, covered)).toMatchObject({ overdue: false, left: 114520 + 122700 - 120000 });
  });

  it('un ciclo que venció antes de compartir la cuenta no se cobra', () => {
    expect(contribution(40.9, 5, '2026-10-26', '2026-10-20', incomes, [])).toMatchObject({ arrears: 0, left: 122700 });
  });

  it('el día límite cuenta como vigente y el 31 se recorta a fin de mes', () => {
    expect(contribution(40, 5, '2026-11-05', since, incomes, [])).toMatchObject({ dueDate: '2026-11-05', daysLeft: 0 });
    expect(contribution(40, 31, '2027-02-10', since, {}, [])).toMatchObject({ dueDate: '2027-02-28', base: '2027-01-01' });
    expect(contribution(40, 31, '2027-01-10', since, {}, [])).toMatchObject({ dueDate: '2027-01-31', base: '2026-12-01' });
  });
});
