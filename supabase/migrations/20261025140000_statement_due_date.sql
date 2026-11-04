-- "Fecha Máxima de Pago" del estado de cuenta de una tarjeta: manda sobre accounts.due_day (el banco la puede mover).
-- null en cuentas de débito y en el monto anotado a mano antes de que llegue el correo.
alter table public.statements add column due_date date;
