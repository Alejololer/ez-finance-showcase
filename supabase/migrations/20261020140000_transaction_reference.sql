-- Número de comprobante/documento del banco: identifica el movimiento sin ambigüedad.
-- No es unique: las dos patas de una transferencia comparten el mismo comprobante.
alter table public.transactions add column reference text check (length(reference) <= 40);
create index transactions_user_reference on public.transactions (user_id, reference) where reference is not null;
