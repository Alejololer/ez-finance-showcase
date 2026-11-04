import { describe, expect, it } from 'vitest';
import { cardFees, cardStatus, cycle, formatTiers, parseTiers } from './card';

describe('cycle', () => {
  it('corte 15 y pago 30: antes y después del corte', () => {
    // 15 nov 2026 es domingo → el próximo corte se adelanta al viernes 13
    expect(cycle(15, 30, '2026-10-20')).toEqual({ lastClose: '2026-10-15', nextClose: '2026-11-13', dueDate: '2026-10-30' });
    expect(cycle(15, 30, '2026-10-10')).toEqual({ lastClose: '2026-09-15', nextClose: '2026-10-15', dueDate: '2026-09-30' });
    expect(cycle(15, 30, '2026-10-15').lastClose).toBe('2026-10-15'); // el día del corte ya cerró
  });

  it('pago antes que el corte en el mes → el pago cae el mes siguiente', () => {
    expect(cycle(25, 10, '2026-11-26')).toEqual({ lastClose: '2026-11-25', nextClose: '2026-12-25', dueDate: '2026-12-10' });
  });

  it('fin de mes y cambio de año', () => {
    expect(cycle(31, 15, '2027-04-05')).toEqual({ lastClose: '2027-03-31', nextClose: '2027-04-30', dueDate: '2027-04-15' });
    expect(cycle(31, 15, '2028-03-05').lastClose).toBe('2028-02-29'); // bisiesto (martes)
    expect(cycle(20, 5, '2027-01-28')).toEqual({ lastClose: '2027-01-20', nextClose: '2027-02-19', dueDate: '2027-02-05' });
    expect(cycle(20, 5, '2027-01-19').lastClose).toBe('2026-12-18'); // 20 dic 2026 domingo → viernes 18
  });

  it('corte en fin de semana se adelanta al viernes; pago en fin de semana pasa al lunes', () => {
    // Pacificard: corte 24 (sábado 24 oct 2026) → 23; paga el 9 nov (lunes)
    expect(cycle(24, 9, '2026-10-23')).toEqual({ lastClose: '2026-10-23', nextClose: '2026-11-24', dueDate: '2026-11-09' });
    expect(cycle(24, 9, '2026-10-24').lastClose).toBe('2026-10-23');
    expect(cycle(24, 9, '2026-10-22').lastClose).toBe('2026-09-24');
    expect(cycle(24, 12, '2026-11-25').dueDate).toBe('2026-12-14'); // 12 dic 2026 sábado → lunes 14
    // día 1 en domingo (1 nov 2026) → viernes 30 oct: el 31 ya es del ciclo nuevo
    expect(cycle(1, 20, '2026-10-31')).toEqual({ lastClose: '2026-10-30', nextClose: '2026-12-01', dueDate: '2026-11-20' });
  });
});

describe('cardStatus', () => {
  const c = cycle(15, 30, '2026-10-20'); // corte 15 oct, paga hasta 30 oct
  const tx = (date: string, amount_cents: number, kind = 'expense') => ({ date, amount_cents, kind });

  it('facturado al corte, consumos del ciclo nuevo aparte', () => {
    const s = cardStatus([tx('2026-10-01', -41055), tx('2026-10-10', -2000), tx('2026-10-18', -500)], c, '2026-10-20');
    expect(s).toMatchObject({ statement: 43055, paid: 0, due: 43055, cycleSpent: 500, overdue: false, daysLeft: 10 });
  });

  it('pago parcial y pago total', () => {
    const base = [tx('2026-10-01', -43055)];
    expect(cardStatus([...base, tx('2026-10-22', 20000, 'transfer')], c, '2026-10-22').due).toBe(23055);
    expect(cardStatus([...base, tx('2026-10-22', 43055, 'transfer')], c, '2026-10-22')).toMatchObject({ due: 0, overdue: false });
  });

  it('vencido si queda saldo después de la fecha límite', () => {
    // hoy 2 nov: el corte vigente sigue siendo el 15 oct y su límite (30 oct) ya pasó
    expect(cardStatus([tx('2026-10-01', -1000)], cycle(15, 30, '2026-11-02'), '2026-11-02'))
      .toMatchObject({ due: 1000, overdue: true, daysLeft: -3 });
  });

  it('lo facturado por el banco manda: compras en tránsito quedan para el próximo corte', () => {
    const txs = [tx('2026-10-01', -41055), tx('2026-10-10', -1306)];
    expect(cardStatus(txs, c, '2026-10-20', 1306)).toMatchObject({ statement: 1306, due: 1306 });
    expect(cardStatus([...txs, tx('2026-10-21', 1306, 'transfer')], c, '2026-10-21', 1306)).toMatchObject({ due: 0 });
  });

  it('sin deuda al corte → nada que pagar aunque haya consumos nuevos', () => {
    expect(cardStatus([tx('2026-10-18', -900)], c, '2026-10-20')).toMatchObject({ statement: 0, due: 0, cycleSpent: 900 });
  });
});

describe('cardFees', () => {
  const tiers = parseTiers('35000: 5, 50000: 6.50, 80000: 7')!;
  const card = { monthly_fee_tiers: tiers, annual_fee_cents: 3910, annual_fee_month: 3 };

  it('desgravamen solo con deuda al corte', () => {
    expect(cardFees(card, '2026-10-24', -41055)).toEqual([{ cents: 500, merchant: 'Desgravamen', reference: 'DESG-20261024' }]);
    expect(cardFees(card, '2026-10-24', 0)).toEqual([]);
    expect(cardFees({ ...card, monthly_fee_tiers: null }, '2026-10-24', -41055)).toEqual([]);
  });

  it('desgravamen por tramos de deuda (tope incluido; sobre el último, el último)', () => {
    const fee = (debt: number) => cardFees(card, '2026-10-24', -debt)[0].cents;
    expect([fee(1), fee(3500000), fee(3500001), fee(5000000), fee(5000001), fee(8000000), fee(9000000)])
      .toEqual([500, 500, 650, 650, 700, 700, 700]);
  });

  it('costo anual en su mes, con o sin deuda', () => {
    expect(cardFees(card, '2027-03-24', 0)).toEqual([{ cents: 3910, merchant: 'Costo anual', reference: 'ANUAL-2027' }]);
    expect(cardFees(card, '2027-03-24', -100).map((f) => f.merchant)).toEqual(['Desgravamen', 'Costo anual']);
  });
});

describe('parseTiers', () => {
  it('fijo, tramos e inválidos', () => {
    expect(parseTiers('5')).toEqual([{ upto: null, cents: 500 }]);
    expect(parseTiers('35000: 5; 50000.50: 6,5')).toEqual([{ upto: 3500000, cents: 500 }, { upto: 5000050, cents: 650 }]);
    expect(formatTiers(parseTiers('35000: 5, 50000: 6.50, 80000: 7')!)).toBe('35000: 5.00, 50000: 6.50, 80000: 7.00');
    for (const bad of ['', '0', 'cinco', '50000: 5, 35000: 6', '35,000: 5', '35000: 0']) expect(parseTiers(bad)).toBeNull();
  });
});
