FROM denoland/deno:latest

WORKDIR /app

# Cache dependencies first (layer cache)
COPY aibuilderapi/deno.json aibuilderapi/deno.lock* ./
RUN deno install

# Copy source
COPY aibuilderapi/ .

# Cache all imports
RUN deno cache src/deno-entry.js

EXPOSE 8000

CMD ["run", "--allow-all", "--unstable-kv", "src/deno-entry.js"]
