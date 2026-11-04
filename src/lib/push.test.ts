import { describe, expect, it } from 'vitest';
import { inboxNotice, testNotice } from './push';

const APP = 'https://ez-finance.example.com';

describe('inboxNotice', () => {
  it('un movimiento: título en singular y el detalle en el cuerpo', () => {
    const p = inboxNotice([{ kind: 'expense', cents: -1250, merchant: 'SUPERMAXI' }], APP);
    expect(p.web_push).toBe(8030);
    expect(p.notification.title).toBe('Nuevo en la bandeja');
    expect(p.notification.body).toBe('Gasto de $12.50 en SUPERMAXI');
    expect(p.notification.navigate).toBe(`${APP}/inbox`);
    expect(p.notification.tag).toBe('inbox');
    expect(p).not.toHaveProperty('app_badge');
  });

  it('ingresos, transferencias y revisiones', () => {
    const p = inboxNotice([
      { kind: 'income', cents: 50000, merchant: 'Juan Pérez' },
      { kind: 'transfer', cents: 10000 },
      { kind: 'review' },
    ], APP, 4);
    expect(p.notification.title).toBe('3 nuevos en la bandeja');
    expect(p.notification.body).toBe('Ingreso de $500.00 de Juan Pérez\nTransferencia de $100.00\nUn aviso necesita revisión');
    expect(p.app_badge).toBe(4);
  });

  it('sin comercio y con más de tres: resume el resto', () => {
    const items = Array.from({ length: 5 }, () => ({ kind: 'expense' as const, cents: -100, merchant: null }));
    const p = inboxNotice(items, APP);
    expect(p.notification.body.split('\n')).toEqual(['Gasto de $1.00', 'Gasto de $1.00', 'Gasto de $1.00', 'y 2 más']);
  });
});

describe('testNotice', () => {
  it('abre ajustes', () => {
    expect(testNotice(APP).notification.navigate).toBe(`${APP}/settings`);
  });
});
