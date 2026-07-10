/* Quay 1 — shared Supabase auth gate.
 *
 * Mirrors quay-leads / quay-clock: same Supabase project, same PIN login via
 * a synthetic `<username>@quay1.local` email, so staff sign in with the exact
 * same credentials they use on the other Quay 1 systems.
 *
 * Team Insights surfaces management data (deal health, the division
 * directory, hiring), so access is restricted to super/admin staff — matching
 * quay-leads' "superuser access only" gate.
 *
 * NOTE: this is a client-side UI gate. On a static host the raw data/*.json
 * files remain directly fetchable by URL; true data-at-rest protection would
 * require serving the data from Supabase behind RLS. High-sensitivity hiring
 * data is not persisted statically — the recruitment forms POST to the Apps
 * Script backend — so it is not exposed by those static files.
 */
window.AUTH = (() => {
  const cfg = window.QUAY_CFG || {};
  let _client = null;

  function client() {
    if (!_client) {
      _client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return _client;
  }

  const emailFor = (u) => `${(u || '').toLowerCase().trim()}@${cfg.AUTH_EMAIL_DOMAIN}`;

  // Only active super/admin staff may view Team Insights.
  function _gate(staff) {
    if (!staff) return { ok: false, error: 'No staff record for this login.' };
    if (staff.active === false) return { ok: false, error: 'This account is disabled.' };
    if (!staff.is_super && !staff.is_admin) {
      return { ok: false, error: 'Team Insights is limited to admin staff.' };
    }
    return { ok: true, user: {
      username: staff.id, name: staff.name,
      isSuper: !!staff.is_super, isAdmin: !!staff.is_admin,
    } };
  }

  async function signIn(username, pin) {
    const sb = client();
    const { data, error } = await sb.auth.signInWithPassword({
      email: emailFor(username), password: pin,
    });
    if (error || !data || !data.user) {
      return { ok: false, error: 'Username or PIN not recognised.' };
    }
    const { data: staff } = await sb.from('staff').select('*')
      .eq('auth_user_id', data.user.id).maybeSingle();
    const g = _gate(staff);
    if (!g.ok) await sb.auth.signOut();  // don't leave a half-authed session
    return g;
  }

  async function getSession() {
    const sb = client();
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return null;
    const { data: staff } = await sb.from('staff').select('*')
      .eq('auth_user_id', data.session.user.id).maybeSingle();
    const g = _gate(staff);
    return g.ok ? g.user : null;
  }

  async function signOut() {
    try { await client().auth.signOut(); } catch (_) { /* ignore */ }
  }

  return { signIn, getSession, signOut };
})();
