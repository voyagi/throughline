/**
 * Where the console looks for the API.
 *
 * A build-time value, inlined into the bundle, which is why it is PUBLIC_ prefixed: Astro only
 * exposes variables with that prefix to client code, and that boundary is the reason nothing
 * secret can end up here by accident.
 *
 * The default is the loopback address the API's own dev script binds to. It is a default and not a
 * fallback in the apologetic sense: a console built with no configuration is a console for the
 * machine it was built on, which is exactly what the demo recording needs. The deploy sets
 * PUBLIC_API_BASE to the real origin, and that origin has to appear in the API's
 * CORS_ALLOWED_ORIGINS or the browser refuses every call.
 */
const RAW = import.meta.env.PUBLIC_API_BASE ?? 'http://127.0.0.1:8787';

/** Without the trailing slash, so a path can be appended without producing a double slash. */
export const API_BASE = RAW.replace(/\/+$/, '');
