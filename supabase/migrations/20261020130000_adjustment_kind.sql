-- Ajuste de saldo: lleva una cuenta a su saldo real sin contar como gasto ni ingreso del mes.
alter table public.transactions drop constraint transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('expense', 'income', 'transfer', 'adjustment'));
