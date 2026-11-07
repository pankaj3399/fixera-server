/** Only a single, explicitly allowed loopback MongoDB host may run local fixtures. */
export const isLocalMongoTestUri = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  try {
    const uri = new URL(value);
    return uri.protocol === 'mongodb:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname.toLowerCase());
  } catch {
    return false;
  }
};
