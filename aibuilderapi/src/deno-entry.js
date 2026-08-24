// Deno Deploy entrypoint — same app, Deno.KV storage, env from dashboard vars.

import { app } from './app.js';
import { useStore } from './store.js';
import { createKvStore } from './store-kv.js';
import { setVars } from './env.js';

const kv = await Deno.openKv();
useStore(createKvStore(kv));

function envVars() {
  return {
    OLLAMA_API_KEY: Deno.env.get('OLLAMA_API_KEY') || '',
    OLLAMA_MODEL: Deno.env.get('OLLAMA_MODEL') || 'gemma4:31b',
    ALLOW_ALL_MODELS: Deno.env.get('ALLOW_ALL_MODELS') || '',
    PORT: Deno.env.get('PORT') || '8000',
  };
}

Deno.serve((req) => {
  const env = envVars();
  setVars(env);
  const ctx = { waitUntil() {} };
  return app.fetch(req, env, ctx);
});
