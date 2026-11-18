export function safeReturnUrl(value: string): string {
  if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/connections';
  const [path, query = ''] = value.split('?', 2);
  if (path === '/access' || path === '/embed' || path === '/oauth/return' || path === '/setup' ||
      path.startsWith('/setup/') || path === '/channels') return '/connections';
  const safePaths = path === '/connections' || path === '/templates' || path === '/notifications' || path === '/status' ||
    /^\/connections\/new\/[a-z-]+$/.test(path) || /^\/connections\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/assets\/[A-Za-z0-9_-]{1,128}$/.test(path);
  if (!safePaths) return '/connections';
  const parameters = new URLSearchParams(query);
  const safeParameters = new URLSearchParams();
  const allowedKeys = new Set(['authVariant', 'filter', 'page', 'pageSize', 'product', 'sort']);
  const instagramVariants = new Set(['INSTAGRAM_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN']);
  for (const [key, parameterValue] of parameters) {
    if (!allowedKeys.has(key) || parameterValue.length > 128) continue;
    if (key === 'authVariant' && (path !== '/connections/new/instagram' || !instagramVariants.has(parameterValue))) continue;
    safeParameters.set(key, parameterValue);
  }
  const queryString = safeParameters.toString();
  return queryString ? `${path}?${queryString}` : path;
}
