-- Una cuenta puede identificarse por varios números (cuenta + tarjetas de débito/crédito asociadas): "7105,5518".
alter table public.accounts drop constraint accounts_last4_check;
alter table public.accounts add constraint accounts_last4_check check (last4 ~ '^\d{4}(,\d{4}){0,9}$');
