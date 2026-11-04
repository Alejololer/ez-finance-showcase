declare namespace App {
  interface Locals {
    supabase: import('@supabase/supabase-js').SupabaseClient;
    userId?: string;
  }
}
