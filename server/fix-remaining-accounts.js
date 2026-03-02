/**
 * Fix name spacing issues and create remaining employee accounts.
 */
const bcrypt = require('bcrypt');
const { getDb } = require('./db');
const db = getDb();

const accounts = [
  { employeeId: 2, pin: '763910', name: 'Alanis Archeval Collazo' },
  { employeeId: 5, pin: '962568', name: 'Alexa Barral Morales' },
  { employeeId: 21, pin: '610989', name: 'Kettylian Cruz Navedo' },
  { employeeId: 85, pin: '594992', name: 'Axel Rivera Quiros' }
];

async function create() {
  for (const a of accounts) {
    // Check if account already exists
    const existing = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(a.employeeId);
    if (existing) {
      console.log(`  Skipped: ${a.name} (already has account)`);
      continue;
    }
    const hash = await bcrypt.hash(a.pin, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)'
    ).run(a.pin, hash, 'employee', a.employeeId);
    console.log(`  Created: ${a.name} → PIN ${a.pin}`);
  }

  const total = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'employee'").get();
  console.log(`\nTotal employee accounts: ${total.cnt}`);

  const missing = db.prepare(
    "SELECT e.id, e.full_name FROM employees e WHERE e.status = 'active' AND e.id NOT IN (SELECT employee_id FROM users WHERE employee_id IS NOT NULL)"
  ).all();
  console.log(`Active employees still without accounts: ${missing.length}`);
  missing.forEach(m => console.log(`  - ${m.full_name} (ID: ${m.id})`));
}

create().catch(console.error);
