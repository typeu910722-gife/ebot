// Send visitors on an old hostname to the main one (set both in wrangler.toml [vars]).
// API calls are left alone so runners pointed at the old address keep working.
export async function onRequest({ request, env, next }) {
  const canonical = env.CANONICAL_HOST, legacy = (env.LEGACY_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const url = new URL(request.url);
  if (canonical && legacy.includes(url.hostname) && request.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.endsWith('-runner.mjs')) {
    url.hostname = canonical;
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
