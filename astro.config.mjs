// @ts-check
import { defineConfig, envField } from 'astro/config';

import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel(),

  env: {
    schema: {
      PUBLIC_SUPABASE_URL: envField.string({ context: 'client', access: 'public' }),
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: envField.string({ context: 'client', access: 'public' }),
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret' }),
      // Fine-grained PAT con Actions: write (dispara el parser) e Issues: write (reportes del piloto) sobre el repo.
      // Sin él, los avisos esperan al cron y los reportes quedan solo en la tabla `reports`.
      GITHUB_DISPATCH_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Notificaciones push (VAPID, `npx web-push generate-vapid-keys`). Las mismas dos también como secretos del repo
      // (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) para que el parser avise. Sin ellas, /settings dice que no están configuradas.
      PUBLIC_VAPID_PUBLIC_KEY: envField.string({ context: 'client', access: 'public', optional: true }),
      VAPID_PRIVATE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },

  vite: {
    plugins: [tailwindcss()]
  }
});