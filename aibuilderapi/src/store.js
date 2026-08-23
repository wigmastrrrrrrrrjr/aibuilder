// Storage interface shared by local SQLite (db.js) and Cloudflare D1 (store-d1.js).
// Every store method is async so the two backends are drop-in swappable.

let impl = null;

export const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

/** Plug in a backend implementation (done by db.js locally, worker.js on CF). */
export function useStore(next) { impl = next; }

export const store = new Proxy({}, {
  get(_, prop) {
    return (...args) => {
      if (!impl) return Promise.reject(new Error('no storage backend initialised'));
      return Promise.resolve(impl[prop](...args));
    };
  },
});
