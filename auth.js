/* Quay 1 - shared Supabase auth gate.
 *
 * Mirrors quay-leads / quay-clock: same Supabase project, same PIN login via
 * a synthetic `<username>@quay1.local` email, so staff sign in with the exact
 * same credentials they use on the other Quay 1 systems.
 *
 * Team Insights surfaces management data (deal health, the division
 * directory, hiring), so access is restricted to super/admin staff - matching
 * quay-leads' "superuser access only" gate.
 *
 * NOTE: this is a client-side UI gate. On a static host the raw data/*.json
 * files remain directly fetchable by URL; true data-at-rest protection would
 * require serving the data from Supabase behind RLS. High-sensitivity hiring
 * data is not persisted statically - the recruitment forms POST to the Apps
 * Script backend - so it is not exposed by those static files.
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

  // Active super / admin / broker / payroll staff may sign in. Supers and
  // admins get the full dashboard; brokers AND payroll are gated down to the
  // Recruitment area in app.js. (Creating these logins is the user's job, done
  // per account.)
  function _gate(staff) {
    if (!staff) return { ok: false, error: 'No staff record for this login.' };
    if (staff.active === false) return { ok: false, error: 'This account is disabled.' };
    // A payroll login is marked by designation 'payroll' (no DB migration
    // needed) or the optional is_payroll flag; either grants Recruitment-only
    // access, same as a broker.
    const isPayroll = staff.designation === 'payroll' || !!staff.is_payroll;
    if (!staff.is_super && !staff.is_admin && !staff.is_broker && !isPayroll) {
      return { ok: false, error: 'This login has no dashboard access.' };
    }
    const isSuper = !!staff.is_super, isAdmin = !!staff.is_admin,
          isBroker = !!staff.is_broker;
    return { ok: true, user: {
      username: staff.id, name: staff.name,
      // Real work email if the staff row carries one, else null. We do NOT
      // fall back to the synthetic <username>@quay1.local login address:
      // recruitment matches a candidate's requester_email against real
      // @quay1.co.za addresses, and a synthetic value would never match (and
      // would silently poison requester_email). Brokers therefore need a real
      // staff.email or they match no candidates, which is the backend's safe
      // default. The staff table has no email column today; see the Progress
      // view note in app.js.
      email: staff.email || null,
      isSuper, isAdmin, isBroker, isPayroll,
      // Coarse role marker app.js uses to choose nav + view scope. Reaches
      // 'payroll' only for a payroll login that is neither super nor admin nor
      // broker, so a payroll user who is also an admin keeps full access.
      role: isSuper ? 'super' : isAdmin ? 'admin' : isBroker ? 'broker' : 'payroll',
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

  // Fresh Supabase JWT for authenticated POST bodies. Call this at REQUEST
  // time (never cache the result) so Supabase's auto-refreshed token is used;
  // access tokens expire roughly hourly.
  async function getAccessToken() {
    const sb = client();
    const { data } = await sb.auth.getSession();
    return (data && data.session) ? data.session.access_token : null;
  }

  return { signIn, getSession, signOut, getAccessToken };
})();
