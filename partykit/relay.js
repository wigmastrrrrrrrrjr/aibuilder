// PartyKit relay server for aibuilder multiplayer.
// Each project gets its own room (room name = project ID).
// Anonymous users are labeled anon #<short-id>.

export default class Relay {
  constructor(ctx) {
    this.room = ctx.room;
    this.connections = new Map(); // ws -> { id, name }
    this.nextId = 1;
  }

  onConnect(ws, ctx) {
    const id = 'u' + (this.nextId++);
    const name = ctx.query.name || ('anon #' + id);
    this.connections.set(ws, { id, name });

    // tell the new user who they are
    ws.send(JSON.stringify({ type: 'identity', id, name }));

    // broadcast join to everyone
    const join = JSON.stringify({ type: 'join', id, name, count: this.connections.size });
    for (const [c] of this.connections) {
      try { c.send(join); } catch {}
    }
  }

  onMessage(message, ws) {
    const user = this.connections.get(ws);
    if (!user) return;

    // stamp the message with sender identity and broadcast to everyone
    const data = JSON.stringify({
      type: 'message',
      user: user.name,
      userId: user.id,
      data: typeof message === 'string' ? tryParse(message) : message,
      ts: Date.now()
    });
    for (const [c] of this.connections) {
      try { c.send(data); } catch {}
    }
  }

  onClose(ws) {
    const user = this.connections.get(ws);
    this.connections.delete(ws);
    if (!user) return;

    const leave = JSON.stringify({ type: 'leave', id: user.id, name: user.name, count: this.connections.size });
    for (const [c] of this.connections) {
      try { c.send(leave); } catch {}
    }
  }
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
