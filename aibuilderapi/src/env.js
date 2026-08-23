// Runtime configuration that works in both environments:
// - Node local dev: .env loader writes into process.env
// - Cloudflare Workers: worker.js injects request env ([vars] + secrets) here

let injected = {};

export function setVars(env) {
  injected = env || {};
}

export function getVar(name) {
  if (injected && injected[name] !== undefined) return injected[name];
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    return process.env[name];
  }
  return undefined;
}
