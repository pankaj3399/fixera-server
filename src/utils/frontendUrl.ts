/** FRONTEND_URL without trailing slashes — safe for `${getFrontendUrl()}/path` */
export function getFrontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
