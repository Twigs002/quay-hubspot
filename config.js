/* Quay 1 — shared frontend config (same Supabase project as quay-clock /
 * quay-leads). Safe to commit: the anon key is public and every table is
 * gated by Postgres RLS. Auth is PIN-based via a synthetic @quay1.local
 * email, so staff use one uniform login across all Quay 1 tools. */
window.QUAY_CFG = Object.freeze({
  SUPABASE_URL: 'https://dqszbqiimbfvmmnpgpsb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY',
  // Synthetic email domain used internally for PIN-based auth.
  AUTH_EMAIL_DOMAIN: 'quay1.local',
});
