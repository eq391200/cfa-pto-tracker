const bcrypt = require('bcrypt');
const { initDb } = require('./db');

async function setup() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';

  const db = initDb();

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Admin user "${username}" already exists. Skipping.`);
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, 'admin');
  console.log(`Admin user "${username}" created successfully.`);
  console.log('You can now start the server with: npm start');
}

// Load .env
const fs = require('fs');
const envPath = require('path').join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

setup().catch(console.error);
