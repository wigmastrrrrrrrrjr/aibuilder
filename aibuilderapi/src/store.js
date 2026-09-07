// Storage interface shared by local SQLite (db.js) and Cloudflare D1 (store-d1.js).
// Every store method is async so the two backends are drop-in swappable.

let impl = null;

export const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

/** Plug in a backend implementation (done by db.js locally, worker.js on CF). */
export function useStore(next) { impl = next; }

// Per-property wrapper is cached so hot call-sites don't re-allocate a closure
// (and correctness note: the bound `this` is the backend impl, which some
// store methods rely on, e.g. saveFile -> this.recordVersion).
const calls = new Map();

export const store = new Proxy({}, {
  get(_, prop) {
    let call = calls.get(prop);
    if (!call) {
      call = (...args) => {
        if (!impl) return Promise.reject(new Error('no storage backend initialised'));
        const m = impl[prop];
        if (typeof m !== 'function') return Promise.reject(new Error(`no such store method: ${String(prop)}`));
        return Promise.resolve(m.apply(impl, args));
      };
      calls.set(prop, call);
    }
    return call;
  },
});
