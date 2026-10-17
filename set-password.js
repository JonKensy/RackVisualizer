// Host-side recovery tool for a lost local password. Run against the ./data
// volume; it rewrites only the PBKDF2 hash in data/users.json (plaintext is
// passed as an argv argument, so run it from a trusted shell).
// Usage (no Node on host):
//   docker run --rm -v "$PWD":/app -w /app node:20-alpine node set-password.js admin 'new-password'
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './lib/auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node set-password.js <username> <new-password>');
  process.exit(1);
}
const file = path.join(process.cwd(), 'data', 'users.json');
const users = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const row = users.find((u) => u.username === username);
if (!row) {
  console.error(`User ${username} not found — start the app once to seed data/users.json`);
  process.exit(1);
}
row.passwordHash = hashPassword(password);
fs.writeFileSync(file, JSON.stringify(users, null, 2) + '\n');
console.log(`Password updated for ${username}`);
