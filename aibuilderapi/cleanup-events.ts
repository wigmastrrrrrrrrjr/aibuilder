import { Database } from 'https://deno.land/x/better_sqlite3/mod.ts';
const db = new Database('data.db');
const count = db.prepare('SELECT COUNT(*) AS c FROM events').get();
console.log('Events before:',count.c);
db.exec('DELETE FROM events');
console.log('CLEARED');
db.close();
