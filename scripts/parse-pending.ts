// Procesa ingest_events 'new' con Claude Code headless (CLAUDE_CODE_OAUTH_TOKEN) y crea transacciones 'pending'.
// Corre en GitHub Actions (.github/workflows/parse.yml). Node 24 ejecuta TS directo.
// No loguear texto crudo ni montos: los logs del Action no son lugar para datos financieros.
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildPrompt, decide, deunaTopup, jsonSchema } from '../src/lib/parse.ts';
import { formatMoney, held } from '../src/lib/money.ts';
import { APP_URL, inboxNotice, sendPush, type InboxItem } from '../src/lib/push.ts';
import { missingLines, parseStatement } from '../src/lib/statement.ts';

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { persistSession: false },
});

function claude(prompt: string, input: string): unknown {
  const res = JSON.parse(
    execFileSync(
      process.env.CLAUDE_BIN ?? 'claude', // en Windows apuntar al claude.exe real (el .cmd no se puede ejecutar sin shell)
      ['-p', prompt, '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--output-format', 'json', '--json-schema', JSON.stringify(jsonSchema)],
      { input, encoding: 'utf8', timeout: 120_000 },
    ),
  );
  if (res.is_error) throw new Error(`claude: ${res.subtype}`);
  return res.structured_output;
}

// Lo nuevo en la bandeja por usuario: al final de la corrida se manda una notificación push a cada uno.
const fresh = new Map<string, InboxItem[]>();
const toInbox = (userId: string, item: InboxItem) => fresh.set(userId, [...(fresh.get(userId) ?? []), item]);

const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
const minutesFrom = (at: string, min: number) => new Date(Date.parse(at) + min * 60_000).toISOString();

const { data: events, error } = await db
  .from('ingest_events')
  .select('id, user_id, source, raw, received_at')
  .eq('status', 'new')
  .order('id')
  .limit(25);
if (error) throw error;

// El push "¡Recibiste X! <pareja> te envió…" de la titular quedó como ingreso pendiente antes de que apareciera el
// aporte (`leg`, pata de entrada en su cuenta común): no es un ingreso, se borra y su evento queda ignorado.
// Si ya lo confirmó no se toca; mientras está pendiente la bandeja lo marca como posible duplicado.
async function dropContributionPush(leg: { user_id: string; amount_cents: number }, date: string, evId: number) {
  const income = await db.from('transactions').select('id, ingest_event_id').eq('user_id', leg.user_id).eq('kind', 'income')
    .eq('status', 'pending').in('source', ['android', 'ios']).eq('amount_cents', leg.amount_cents)
    .gte('date', shiftDay(date, -1)).lte('date', shiftDay(date, 1)).limit(1).maybeSingle();
  if (income.error) throw income.error;
  if (!income.data) return;
  const del = await db.from('transactions').delete().eq('id', income.data.id);
  if (del.error) throw del.error;
  const upd = await db.from('ingest_events')
    .update({ status: 'ignored', error: `Aporte a la cuenta común (registrado en el evento ${evId})` })
    .eq('id', income.data.ingest_event_id ?? -1);
  if (upd.error) throw upd.error;
}

async function handle(ev: NonNullable<typeof events>[number]) {
  // Cuentas comunes aceptadas (account_members): las de otra titular entran a la lista de cuentas (la otra persona
  // deposita en ellas); las propias sirven para reconocer el push de ese depósito.
  const members = await db.from('account_members').select('account_id, owner_id').not('user_id', 'is', null)
    .or(`user_id.eq.${ev.user_id},owner_id.eq.${ev.user_id}`);
  if (members.error) throw members.error;
  const joined = members.data.filter((m) => m.owner_id !== ev.user_id);
  const ownShared = members.data.filter((m) => m.owner_id === ev.user_id).map((m) => m.account_id);
  const [accounts, cats, past] = await Promise.all([
    db.from('accounts').select('id, user_id, name, type, currency, last4, is_default')
      .or(`user_id.eq.${ev.user_id}${joined.length ? `,id.in.(${joined.map((m) => m.account_id).join(',')})` : ''}`).order('id'),
    db.from('categories').select('id, user_id, name').in('user_id', [ev.user_id, ...joined.map((m) => m.owner_id)]),
    // Lo que el usuario ya confirmó con categoría: el prompt lo usa para reconocer comercios y personas recurrentes.
    db.from('transactions').select('merchant, category_id').eq('user_id', ev.user_id).eq('status', 'confirmed')
      .in('kind', ['expense', 'income']).not('category_id', 'is', null).neq('merchant', '')
      .order('id', { ascending: false }).limit(300),
  ]);
  if (accounts.error) throw accounts.error;
  if (cats.error) throw cats.error;
  if (past.error) throw past.error;
  const categories = cats.data.filter((c) => c.user_id === ev.user_id);
  for (const a of accounts.data) if (a.user_id !== ev.user_id) a.is_default = false; // la común de otra titular
  // Una fila en la cuenta común de otra titular es suya (FK compuesta) y lleva su categoría del mismo nombre.
  const ownerOf = (id: unknown) => accounts.data.find((a) => a.id === id)?.user_id ?? ev.user_id;
  const place = (row: Record<string, unknown>) => {
    const user_id = ownerOf(row.account_id);
    if (user_id === ev.user_id || !row.category_id) return { ...row, user_id };
    const name = categories.find((c) => c.id === row.category_id)?.name;
    return { ...row, user_id, category_id: cats.data.find((c) => c.user_id === user_id && c.name === name)?.id ?? null };
  };
  const history = new Map<string, { merchant: string; category: string }>();
  for (const t of past.data) {
    const category = categories.find((c) => c.id === t.category_id)?.name;
    const key = t.merchant?.trim().toLowerCase();
    if (category && key && !history.has(key) && history.size < 40) history.set(key, { merchant: t.merchant!.trim(), category });
  }

  // Estados de cuenta: formato fijo, se leen sin Claude. El saldo queda en `statements` y reconcile.ts ajusta.
  const st = parseStatement(ev.raw, accounts.data, ev.received_at);
  if (st) {
    let error = st.status === 'review' ? st.error : null;
    if (st.status === 'statement') {
      const up = await db.from('statements').upsert(
        { user_id: ownerOf(st.account_id), account_id: st.account_id, date: st.date, balance_cents: st.balance_cents, due_date: st.due_date ?? null, ingest_event_id: ev.id },
        { onConflict: 'account_id,date' },
      );
      if (up.error) throw up.error;
      // Tarjeta: cada línea del estado se cruza con lo registrado (pendiente o confirmado). Los cargos que falten
      // (emisión, IVA de servicios digitales, intereses: el banco no los avisa) entran a la bandeja como pendientes.
      // Reintentar es inocuo: la segunda vez el cruce encuentra los pendientes ya creados.
      if (st.lines === null) error = 'Estado de cuenta: no se pudo leer el detalle del PDF; revisa a mano los cargos del corte';
      if (st.lines?.length) {
        const from = st.lines.reduce((m, l) => (l.date < m ? l.date : m), st.date);
        const txs = await db.from('transactions').select('id, date, amount_cents').eq('account_id', st.account_id)
          .in('status', ['pending', 'confirmed']).gte('date', shiftDay(from, -10)).lte('date', shiftDay(st.date, 3));
        if (txs.error) throw txs.error;
        const missing = missingLines(st.lines, txs.data);
        const charges = missing.filter((l) => l.cents < 0);
        if (charges.length) {
          const ins = await db.from('transactions').insert(charges.map((l) => ({
            user_id: ownerOf(st.account_id), account_id: st.account_id, amount_cents: l.cents, date: l.date, kind: 'expense',
            status: 'pending', source: 'email', merchant: l.description, description: 'Del estado de cuenta', ingest_event_id: ev.id,
          })));
          if (ins.error) throw ins.error;
          for (const l of charges) toInbox(ev.user_id, { kind: 'expense', cents: l.cents, merchant: l.description });
        }
        // Un pago o devolución que la app no tiene: no se inventa la transferencia, se avisa.
        const credits = missing.filter((l) => l.cents > 0);
        if (credits.length) {
          error = `Estado de cuenta: el banco registra ${credits.map((l) => `${l.description} ${formatMoney(l.cents, 'USD')} (${l.date})`).join(', ')} y la app no. Regístralo para que el saldo cuadre.`;
        }
        console.log(`event ${ev.id}: ${st.lines.length} lines, ${charges.length} pending`);
      }
    }
    const upd = await db.from('ingest_events')
      .update({ status: error ? 'review' : 'parsed', parsed: st, error })
      .eq('id', ev.id);
    if (upd.error) throw upd.error;
    if (error) toInbox(ev.user_id, { kind: 'review' });
    console.log(`event ${ev.id}: ${st.status}`);
    return;
  }

  // Recargas de DeUna: formato fijo, sin Claude. Si Claude falla (límite de uso, red) el evento queda 'new' y lo
  // retoma la próxima corrida.
  const topup = deunaTopup(ev.raw, accounts.data, ev.received_at);
  const out = topup ?? claude(buildPrompt(categories.map((c) => c.name), accounts.data, ev.received_at, [...history.values()]), ev.raw);
  const d = topup ?? decide(out, { receivedAt: ev.received_at, accounts: accounts.data, categories, text: ev.raw });

  const reference = d.status === 'parsed' ? d.tx.reference : d.status === 'transfer' ? d.reference : null;
  if (reference) {
    // Mismo comprobante ya registrado (otro correo/notificación del mismo movimiento): duplicado seguro, no se crea nada.
    const seen = await db.from('transactions').select('id').eq('user_id', ev.user_id).eq('reference', reference).limit(1).maybeSingle();
    if (seen.error) throw seen.error;
    if (seen.data) {
      const upd = await db.from('ingest_events')
        .update({ status: 'ignored', parsed: out, error: `Duplicado: comprobante ${reference} ya registrado` })
        .eq('id', ev.id);
      if (upd.error) throw upd.error;
      console.log(`event ${ev.id}: duplicate`);
      return;
    }
  }

  if (d.status === 'transfer') {
    // Pago registrado a mano (botón "registrar pago") y luego llega el correo del banco: es el mismo movimiento.
    // Se absorbe si coinciden origen, destino y monto (±3 días, el banco puede acreditar después), salvo que
    // ambos tengan comprobantes distintos: eso indica un segundo pago real.
    const manual = await db
      .from('transactions')
      .select('date, transfer_id, reference')
      .eq('user_id', ev.user_id)
      .eq('source', 'manual')
      .eq('kind', 'transfer')
      .eq('account_id', d.from_id)
      .eq('amount_cents', -d.amount_cents)
      .gte('date', shiftDay(d.date, -3))
      .lte('date', shiftDay(d.date, 3))
      .order('date');
    if (manual.error) throw manual.error;
    let match: (typeof manual.data)[number] | undefined;
    let inLeg: { user_id: string; amount_cents: number } | undefined;
    for (const m of manual.data) {
      if (m.reference && d.reference && m.reference !== d.reference) continue;
      const leg = await db.from('transactions').select('user_id, amount_cents')
        .eq('transfer_id', m.transfer_id).eq('account_id', d.to_id).eq('amount_cents', d.amount_cents).maybeSingle();
      if (leg.error) throw leg.error;
      if (leg.data) { match = m; inLeg = leg.data; break; }
    }
    if (match) {
      // Aporte registrado con el botón después del push de la titular: ese push ya quedó como ingreso pendiente.
      if (inLeg!.user_id !== ev.user_id) await dropContributionPush(inLeg!, match.date, ev.id);
      if (d.reference && !match.reference) {
        const ref = await db.from('transactions').update({ reference: d.reference }).eq('transfer_id', match.transfer_id);
        if (ref.error) throw ref.error;
      }
      const upd = await db.from('ingest_events')
        .update({ status: 'ignored', parsed: out, error: `Reconciliado con la transferencia registrada a mano el ${match.date}` })
        .eq('id', ev.id);
      if (upd.error) throw upd.error;
      console.log(`event ${ev.id}: reconciled`);
      return;
    }
  }

  if (d.status === 'parsed' || d.status === 'transfer') {
    const cents = d.status === 'parsed' ? d.tx.amount_cents : -d.amount_cents;
    const date = d.status === 'parsed' ? d.tx.date : d.date;

    // Correo y push del mismo movimiento: Pichincha avisa por ambos lados las transferencias (también entre cuentas
    // propias: "¡Recibiste 10.00! <tu nombre> te envió…") y llegan con segundos de diferencia. Mismo monto con signo
    // (el push "Recibiste +10" coincide con la pata de entrada de la transferencia del correo) y ±15 min entre
    // avisos de canales distintos → es uno solo. Gana el correo (trae comprobante y cuentas). Nunca entre dos push
    // ni dos correos: recargar $1 a DeUna y pagar $1 desde DeUna son dos movimientos.
    // ponytail: un ingreso real de un tercero por el mismo monto en esos 15 min se absorbería; no pasa en la práctica.
    const push = ev.source !== 'email';
    const near = await db
      .from('transactions')
      .select('id, status, ingest_event_id, ingest_events(received_at)')
      .eq('user_id', ev.user_id)
      .in('amount_cents', d.status === 'parsed' ? [cents] : [cents, -cents])
      .in('source', push ? ['email'] : ['android', 'ios'])
      .gte('date', shiftDay(date, -1))
      .lte('date', shiftDay(date, 1));
    if (near.error) throw near.error;
    const twin = near.data.find((t) => {
      const at = (t.ingest_events as unknown as { received_at: string } | null)?.received_at;
      return at && Math.abs(Date.parse(at) - Date.parse(ev.received_at)) <= 15 * 60_000;
    });
    let twinOf: number | null = null;
    if (twin && push) {
      const upd = await db.from('ingest_events')
        .update({ status: 'ignored', parsed: out, error: `Reconciliado con el correo del mismo movimiento (evento ${twin.ingest_event_id})` })
        .eq('id', ev.id);
      if (upd.error) throw upd.error;
      console.log(`event ${ev.id}: reconciled`);
      return;
    }
    if (twin && twin.status === 'pending') {
      // El push llegó primero: su pendiente se reemplaza por el del correo (por evento, cubre las dos patas).
      const del = await db.from('transactions').delete().eq('ingest_event_id', twin.ingest_event_id).eq('status', 'pending');
      if (del.error) throw del.error;
      const upd = await db.from('ingest_events')
        .update({ error: `Reconciliado con el correo del mismo movimiento (evento ${ev.id})`, status: 'ignored' })
        .eq('id', twin.ingest_event_id);
      if (upd.error) throw upd.error;
    } else if (twin) {
      twinOf = twin.id; // ya confirmado: decide el usuario
    }

    // Mismo movimiento avisado dos veces (las dos patas de una transferencia, dos correos):
    // se marca como posible duplicado y el usuario decide en /inbox.
    let q = db
      .from('transactions')
      .select('id')
      .eq('user_id', ev.user_id)
      .eq('amount_cents', cents)
      .gte('date', shiftDay(date, -1))
      .lte('date', shiftDay(date, 1));
    // Solo se compara con movimientos del mismo tipo: pasar $125 del ahorro a la corriente y pagar $125 con débito
    // son dos movimientos (la pata de salida de la transferencia tiene el mismo monto que el gasto).
    // Transferencias: además, misma cuenta de origen (ida y vuelta del mismo monto son dos movimientos).
    // Gastos no filtran por cuenta: el email puede traer la tarjeta y la notificación no.
    q = q.eq('kind', d.status === 'parsed' ? d.tx.kind : 'transfer');
    if (d.status === 'transfer') q = q.eq('account_id', d.from_id);
    const dup = await q.limit(1).maybeSingle();
    if (dup.error) throw dup.error;
    // Cuenta común: solo la titular recibe los avisos. El push "¡Recibiste X! <otra persona> te envió…" no es un
    // ingreso suyo: es el aporte que la otra persona ya registró como transferencia hacia la cuenta común. Se ignora.
    // (El orden inverso, aporte después del push, se resuelve tras insertar.)
    // ponytail: un ingreso real de un tercero por el mismo monto ±1 día que un aporte se absorbería.
    if (push && d.status === 'parsed' && d.tx.kind === 'income' && ownShared.length && !twinOf) {
      const r = await db.from('transactions').select('id, ingest_event_id').in('account_id', ownShared).eq('kind', 'transfer')
        .eq('amount_cents', cents).gte('date', shiftDay(date, -1)).lte('date', shiftDay(date, 1)).limit(1).maybeSingle();
      if (r.error) throw r.error;
      if (r.data) {
        const upd = await db.from('ingest_events')
          .update({ status: 'ignored', parsed: out, error: `Aporte a la cuenta común (ya registrado en el evento ${r.data.ingest_event_id ?? 'manual'})` })
          .eq('id', ev.id);
        if (upd.error) throw upd.error;
        console.log(`event ${ev.id}: contribution`);
        return;
      }
    }
    const common = { user_id: ev.user_id, status: 'pending', source: ev.source, ingest_event_id: ev.id, duplicate_of: twinOf ?? dup.data?.id ?? null };
    const rows: Record<string, unknown>[] =
      d.status === 'parsed'
        ? [{ ...d.tx, ...common }]
        : (() => {
            const base = { ...common, kind: 'transfer', transfer_id: randomUUID(), date: d.date, description: d.description, reference: d.reference };
            return [
              { ...base, account_id: d.from_id, amount_cents: -d.amount_cents },
              { ...base, account_id: d.to_id, amount_cents: d.amount_cents },
            ];
          })();
    const ins = await db.from('transactions').insert(rows.map(place)).select('id, user_id, amount_cents');
    if (ins.error) throw ins.error;
    // Lo del celular no se avisa: el banco ya mostró su notificación en ese teléfono y la bandeja lo retiene
    // 8 min (held) esperando el correo; avisar ahí sería un segundo aviso de algo que aún no se ve.
    if (!push) {
      toInbox(ev.user_id, d.status === 'parsed'
        ? { kind: d.tx.kind, cents: d.tx.amount_cents, merchant: d.tx.merchant }
        : { kind: 'transfer', cents: d.amount_cents });
    }

    // Aporte a la cuenta común de otra titular después de su push: ese "ingreso" pendiente era este aporte; se borra.
    const inLeg = ins.data.find((r) => r.user_id !== ev.user_id && r.amount_cents > 0);
    if (d.status === 'transfer' && inLeg) await dropContributionPush(inLeg, date, ev.id);

    // Push sin monto ("¡Recibiste dinero! <tu nombre> te envió dinero", la pata de entrada de una transferencia
    // propia) del mismo momento que este correo: quedó en review y no tiene monto para emparejarlo arriba.
    if (!push) {
      const abs = await db.from('ingest_events')
        .update({ status: 'ignored', error: `Reconciliado con el correo del mismo movimiento (evento ${ev.id})` })
        .eq('user_id', ev.user_id).eq('status', 'review').in('source', ['android', 'ios'])
        .gte('received_at', minutesFrom(ev.received_at, -3)).lte('received_at', minutesFrom(ev.received_at, 3));
      if (abs.error) throw abs.error;
    }
  }

  let status = d.status === 'transfer' ? 'parsed' : d.status;
  let note = d.status === 'review' ? d.error : null;
  if (d.status === 'review' && ev.source !== 'email') {
    // El mismo caso cuando el push llega después que el correo.
    // ponytail: un push real sin monto (ingreso de un tercero) a ±3 min de otro movimiento por correo se absorbería.
    const mail = await db.from('ingest_events').select('id')
      .eq('user_id', ev.user_id).eq('source', 'email').eq('status', 'parsed')
      .gte('received_at', minutesFrom(ev.received_at, -3)).lte('received_at', minutesFrom(ev.received_at, 3))
      .limit(1).maybeSingle();
    if (mail.error) throw mail.error;
    if (mail.data) [status, note] = ['ignored', `Reconciliado con el correo del mismo movimiento (evento ${mail.data.id})`];
  }
  const upd = await db
    .from('ingest_events')
    .update({ status, parsed: out, error: note })
    .eq('id', ev.id);
  if (upd.error) throw upd.error;
  if (status === 'review' && ev.source === 'email') toInbox(ev.user_id, { kind: 'review' });
  console.log(`event ${ev.id}: ${d.status}`);
}

// Un fallo queda en `reports` (con el usuario y el evento) y se relanza: el evento sigue 'new' y el cron reintenta.
// ponytail: un fallo persistente deja una fila por hora; deduplicar si molesta.
// Lo que sí entró a la bandeja antes del fallo se avisa igual (finally).
try {
  for (const ev of events) {
    try {
      await handle(ev);
    } catch (err) {
      const e = err as { message?: string; stack?: string };
      await db.from('reports').insert({
        user_id: ev.user_id, kind: 'error', source: 'parser', message: String(e?.message ?? err).slice(0, 2000) || 'error',
        stack: e?.stack?.slice(0, 8000), context: { event_id: ev.id, ...(err instanceof Error ? {} : { error: err }) },
      });
      throw err;
    }
  }
  console.log(`processed ${events.length}`);
} finally {
  await notify();
}

// Una notificación por usuario con lo que entró a su bandeja en esta corrida. Nunca frena al parser: sin claves VAPID
// no hace nada y un fallo de envío queda en `reports`. Suscripciones muertas (404/410) se borran.
async function notify() {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  if (!publicKey || !privateKey || !fresh.size) return;
  for (const [userId, items] of fresh) {
    try {
      const subs = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
      if (subs.error) throw subs.error;
      if (!subs.data.length) continue;
      const r = await sendPush(subs.data, inboxNotice(items, process.env.APP_URL || APP_URL, await inboxCount(userId)), {
        publicKey, privateKey, subject: APP_URL,
      });
      if (r.gone.length) await db.from('push_subscriptions').delete().in('id', r.gone);
      if (r.failed.length) throw new Error(`push: ${r.failed.join('; ')}`);
      console.log(`push: ${r.sent} sent, ${r.gone.length} gone`);
    } catch (err) {
      const e = err as { message?: string; stack?: string };
      await db.from('reports').insert({
        user_id: userId, kind: 'error', source: 'parser', message: String(e?.message ?? err).slice(0, 2000) || 'error',
        stack: e?.stack?.slice(0, 8000), context: { step: 'push' },
      });
    }
  }
}

// Mismo conteo que el menú (Layout.astro): pendientes (una fila por transferencia) + avisos en revisión, sin lo retenido.
async function inboxCount(userId: string) {
  const [tx, ev] = await Promise.all([
    db.from('transactions').select('source, created_at').eq('user_id', userId).eq('status', 'pending').or('transfer_id.is.null,amount_cents.lt.0'),
    db.from('ingest_events').select('source, received_at').eq('user_id', userId).eq('status', 'review'),
  ]);
  return (tx.data ?? []).filter((t) => !held(t.source, t.created_at)).length +
    (ev.data ?? []).filter((e) => !held(e.source, e.received_at)).length;
}
