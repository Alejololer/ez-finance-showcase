import type { APIRoute } from 'astro';

// Destino de OAuth (Google) y del enlace de confirmación de correo.
// Sin code y con error: Supabase rechazó el registro (correo fuera del piloto, hook before_user_created).
export const GET: APIRoute = async ({ url, locals, redirect }) => {
  const code = url.searchParams.get('code');
  if (code) await locals.supabase.auth.exchangeCodeForSession(code);
  else if (url.searchParams.has('error')) return redirect('/login?error=invitacion');
  return redirect('/');
};
