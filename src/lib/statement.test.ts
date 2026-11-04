import { describe, expect, it } from 'vitest';
import type { Account } from './parse';
import { cutoffDiff, missingLines, parseStatement } from './statement';

const acc = (id: number, o: Partial<Account> = {}): Account => ({
  id, name: `Cuenta ${id}`, type: 'checking', currency: 'USD', last4: null, is_default: false, ...o,
});
const accounts = [acc(1, { is_default: true, last4: '7105' }), acc(2, { last4: '4821', type: 'credit' }), acc(3, { type: 'savings', last4: '9306' })];
const received = '2026-10-16T11:54:48Z';

// Texto con el formato real (abreviado, datos ficticios) del correo de Pichincha + PDF convertido por gmail.gs.
const text = (cuenta = '2200017105', corte = '08-10-2026', resumen = 'SALDO ANTERIOR 7.09 DEPÓSITO / CRÉDITOS (100) 7463.77 CHEQUES / DÉBITOS (154) 7215.15 INTERÉS PERIODO 0.00 SALDO ACTUAL 255.71') => `NOTIFICACION DE ESTADO CUENTA
Fecha: 16/10/2026
Documento: 001-170-000000001
Cuenta: ${cuenta}
Tipo de cuenta: CUENTA AHORRO TRANSACCIONAL
Estado de cuenta del mes: ${corte}
--- PDF adjunto ---
PEREZ LOPEZ JUAN ANDRES CUENTA 2200029306
CONCILIACIÓN
FECHA ÚLTIMO CORTE (FACTURA) 04-09-2026 FECHA ESTE CORTE (FACTURA) 08-10-2026 ${resumen} SALDO PROMEDIO EFECTIVO 32.37`;

describe('parseStatement', () => {
  it('estado real del transaccional → saldo actual en la cuenta del correo (no la del PDF)', () => {
    expect(parseStatement(text(), accounts, received)).toEqual({ status: 'statement', account_id: 1, date: '2026-10-08', balance_cents: 25571 });
  });

  it('interés aparte y miles con coma también cuadran', () => {
    const r = 'SALDO ANTERIOR 3,400.00 DEPÓSITO / CRÉDITOS (2) 100.00 CHEQUES / DÉBITOS (1) 30.00 INTERÉS PERIODO 16.54 SALDO ACTUAL 3,486.54';
    expect(parseStatement(text('2200029306', '08-10-2026', r), accounts, received)).toMatchObject({ status: 'statement', account_id: 3, balance_cents: 348654 });
  });

  it('cualquier otro aviso → null (lo interpreta Claude)', () => {
    expect(parseStatement('¡Transferencia exitosa! Documento 123', accounts, received)).toBeNull();
  });

  it('sin PDF, saldos que no cuadran, cuenta desconocida, tarjeta o corte fuera de rango → review', () => {
    const st = (t: string) => parseStatement(t, accounts, received)?.status;
    expect(st(text().split('--- PDF')[0])).toBe('review');
    expect(st(text(undefined, undefined, 'SALDO ANTERIOR 7.09 CRÉDITOS (100) 7463.77 DÉBITOS (154) 7215.15 SALDO ACTUAL 999.99'))).toBe('review');
    expect(st(text('2200009999'))).toBe('review');
    expect(st(text('5422584821'))).toBe('review');
    expect(st(text(undefined, '20-08-2026'))).toBe('review'); // 57 días
    expect(st(text(undefined, '20-10-2026'))).toBe('review'); // futuro
  });
});

// Correo real de PacifiCard (getPlainBody de una tabla HTML) + página 1 del PDF tal como sale del OCR de Drive
// (columnas separadas: filas arriba, tipos y montos después del resumen). Datos personales cambiados.
const ocr = (rows: string, values: string) => `Pag. 1
Estado de cuenta
Cliente S00000
CLIENTE DE PRUEBA - 0
MASTERCARD: 5422-58XX-XXXX-X458 Gold
Doc. Identidad 0000000000
RESUMEN DE MOVIMIENTOS
Fecha de corte: 23/OCT/2026
DETALLE DE MOVIMIENTOS DEL PERÍODO
FECHA
REFER.
DESCRIPCIÓN
TIPO DE OPERACIÓN
VALOR VALOR MONEDA US$ EXTRANJERA
+/-
SALDO DIFERIDO
****SALDO ANTERIOR
*** DETALLE DE CONSUMOS LOCALES
0000000000
CLIENTE DE PRUEBA
${rows}
TOTAL PAGO DE CONTADO
SALDO ACTUAL ROTATIVO
SALDO ACTUAL DIFERIDO
SUBTOTAL CONSUMOS PERIODO
SUBTOTAL PAGOS/CRÉDITOS
INTERÉS FINANCIAMIENTO
INTERÉS POR MORA
${values}
Dólares
0
Pago Vencido
0.00
Cuota Rotativa
13.06
Pago Mínimo
13.06 `;
const realPdf = ocr(
  `OCT/19 \n959100 SERV.EMISION TARJ/CHIP \n*** DETALLE DE CONSUMOS EN EL EXTERIOR \n0000000000 \nCLIENTE DE PRUEBA \nOCT/22 \n012074 GOOGLE Apple Music \nOCT/22 \n012074 N/D IVA SERVICIO DIGITAL `,
  'CONS \n5.03 \nMOUNTAIN MOUNTAIN \nCONS \nN/D \n6.99 \n1.04 \n6.99 + \n13.06 \n13.06 \n0.00 \n13.06 \n0.00 \n0.00 \n0.00 ',
);
const card = (body = '| Fecha de corte | Fecha Máxima de Pago sin recargos |\n| 23/OCT/2026 | 09/NOV/2026 |\n| Saldo al corte | $ 13.06 | Pago de Contado | $ 13.06 |', pdf: string | null = realPdf) => `Estado de Cuenta PacifiCard - Corte 10/2026
Estimado(a) CLIENTE DE PRUEBA,
| 5422-58XX-XXXX-X458 |
${body}
| Total Consumos del mes | $ 13.06 | Pago mínimo | $ 13.06 |${pdf === null ? '' : `\n--- PDF adjunto ---\n${pdf}`}`;
const cardAccounts = [acc(1, { is_default: true }), acc(31, { type: 'credit', last4: '458', name: 'Pacificard' })];
const cardReceived = '2026-10-25T10:25:24Z';

describe('estado de cuenta de PacifiCard', () => {
  const lines = [
    { date: '2026-10-19', description: 'SERV.EMISION TARJ/CHIP', cents: -503 },
    { date: '2026-10-22', description: 'GOOGLE Apple Music', cents: -699 },
    { date: '2026-10-22', description: 'N/D IVA SERVICIO DIGITAL', cents: -104 },
  ];

  it('corte real → pago de contado como deuda de la tarjeta y las filas del detalle', () => {
    expect(parseStatement(card(), cardAccounts, cardReceived)).toEqual({ status: 'statement', account_id: 31, date: '2026-10-23', balance_cents: -1306, due_date: '2026-11-09', lines });
  });

  it('cuerpo con una celda por línea también se lee', () => {
    const body = 'Fecha de corte\nFecha Máxima de Pago sin recargos\n23/OCT/2026\n09/NOV/2026\nSaldo al corte\n$ 13.06\nPago de Contado\n$ 13.06';
    expect(parseStatement(card(body), cardAccounts, cardReceived)).toMatchObject({ date: '2026-10-23', balance_cents: -1306, due_date: '2026-11-09' });
    // El banco movió la fecha de pago: se toma la del correo, no el día configurado.
    expect(parseStatement(card(body.replace('09/NOV/2026', '12/NOV/2026')), cardAccounts, cardReceived)).toMatchObject({ due_date: '2026-11-12' });
    expect(parseStatement(card(body.replace('09/NOV/2026', '20/OCT/2026')), cardAccounts, cardReceived)?.status).toBe('review');
  });

  it('sin PDF, OCR ilegible o que no cuadra con el pago de contado → total igual, lines null', () => {
    const lost = (pdf: string | null) => parseStatement(card(undefined, pdf), cardAccounts, cardReceived);
    expect(lost(null)).toMatchObject({ balance_cents: -1306, lines: null });
    expect(lost('OCT/19 ilegible')).toMatchObject({ balance_cents: -1306, lines: null });
    expect(lost(realPdf.replace('5.03', '5.30'))).toMatchObject({ lines: null }); // monto mal leído: no suma el subtotal
    expect(lost(realPdf.replace('CONS \n5.03 \n', ''))).toMatchObject({ lines: null }); // falta una columna
  });

  it('pagos en positivo, intereses al corte y diciembre en el corte de enero', () => {
    const body = '| Fecha de corte | Fecha Máxima de Pago sin recargos |\n| 23/ENE/2027 | 09/FEB/2027 |\n| Pago de Contado | $ 812.34 |';
    const pdf = ocr('DIC/28 \n000001 SUPERMAXI QUITO \nENE/05 \n000002 PAGO RECIBIDO ',
      'CONS \nPAGO \n1,000.00 \n200.00 \n812.34 \n812.34 \n0.00 \n1,000.00 \n200.00 \n12.34 \n0.00 ');
    expect(parseStatement(card(body, pdf), cardAccounts, '2027-01-25T10:00:00Z')).toMatchObject({
      date: '2027-01-23', balance_cents: -81234, due_date: '2027-02-09',
      lines: [
        { date: '2026-12-28', description: 'SUPERMAXI QUITO', cents: -100000 },
        { date: '2027-01-05', cents: 20000 },
        { date: '2027-01-23', description: 'Interés de financiamiento', cents: -1234 },
      ],
    });
  });

  it('tarjeta desconocida → review', () => {
    expect(parseStatement(card().replaceAll('X458', 'X999'), cardAccounts, cardReceived)?.status).toBe('review');
  });

  // Movimientos reales de la tarjeta al 25-10: la app anota la compra; el banco, cuando la procesa.
  const txs = [
    { id: 56, date: '2026-10-19', amount_cents: -41055 }, // MercadoLibre: aún en tránsito
    { id: 701, date: '2026-10-19', amount_cents: -503 },
    { id: 97, date: '2026-10-20', amount_cents: -514 },
    { id: 99, date: '2026-10-20', amount_cents: -39 },
    { id: 166, date: '2026-10-21', amount_cents: -699 }, // Apple Music: el banco lo procesó el 22
    { id: 702, date: '2026-10-22', amount_cents: -104 },
    { id: 731, date: '2026-10-24', amount_cents: -499 },
  ];

  it('cruce: todo registrado → nada falta; sin la emisión → falta solo esa', () => {
    expect(missingLines(lines, txs)).toEqual([]);
    expect(missingLines(lines, txs.filter((t) => t.id !== 701))).toEqual([lines[0]]);
  });

  it('cruce: cada movimiento sirve una sola vez y fuera de la ventana no cuenta', () => {
    const two = [lines[2], { ...lines[2], description: 'otro IVA' }];
    expect(missingLines(two, txs)).toEqual([two[1]]);
    expect(missingLines([lines[0]], [{ id: 1, date: '2026-10-05', amount_cents: -503 }])).toEqual([lines[0]]);
  });
});

describe('cutoffDiff', () => {
  it('transferencia de la noche del corte que el banco contó después → queda el interés', () => {
    // Flexible 23-10-2026: banco 600.23, app 400.05; los −200 de las 23:24 cayeron en el corte siguiente.
    expect(cutoffDiff(20018, [70000, -10000, -20000], [])).toBe(18);
  });

  it('movimiento del día siguiente que el banco ya contó', () => {
    expect(cutoffDiff(-5000, [], [-5000, 1200])).toBe(0);
  });

  it('nada la explica → la diferencia sigue igual (va a revisión)', () => {
    expect(cutoffDiff(20018, [70000, -10000], [3000])).toBe(20018);
    expect(cutoffDiff(300, [-300], [])).toBe(300); // chica: se ajusta tal cual
  });
});
