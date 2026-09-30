const stamp = () => new Date().toISOString();

export const log = {
  info: (msg: string, meta?: unknown) =>
    console.log(`${stamp()} ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`),
  warn: (msg: string, meta?: unknown) =>
    console.warn(`${stamp()} WARN ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`),
  error: (msg: string, meta?: unknown) =>
    console.error(`${stamp()} ERROR ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`),
};
