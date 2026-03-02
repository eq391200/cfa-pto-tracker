/**
 * Bulk create employee accounts from PIN report data.
 * Each employee gets their PIN as username, PIN as temporary password,
 * and must_change_password = 1 so they set their own password on first login.
 */
const bcrypt = require('bcrypt');
const { initDb, getDb } = require('./db');

initDb();
const db = getDb();

// PIN data from PDF report — format: "LastName, FirstName" => PIN
const pinData = [
  { name: 'Alfonzo Muniz, Kevin', pin: '732968' },
  { name: 'Archival Collazo, Alanis', pin: '763910' },
  { name: 'Bartolomei Irizarry, Daniel', pin: '919778' },
  { name: 'Bermudez, Jeniffer', pin: '680456' },
  { name: 'Burgos Schmidt, Jorliany', pin: '737368' },
  { name: 'Carmona, Jeshua', pin: '913746' },
  { name: 'Cartagena, Edgardo', pin: '513385' },
  { name: 'Castro, Kaylis', pin: '905463' },
  { name: 'Cherena, Nileika', pin: '870987' },
  { name: 'Colon, Nicole', pin: '880011' },
  { name: 'Cortes, Harrison', pin: '978552' },
  { name: 'Cruz Navedo, Kettyliann', pin: '610989' },
  { name: 'Fabre, Alejandro', pin: '977201' },
  { name: 'Feliciano, Angel', pin: '329608' },
  { name: 'Feliciano, Cristal', pin: '160288' },
  { name: 'Feliciano, Heily', pin: '525084' },
  { name: 'Fernandez Quiles, Jeannette', pin: '514137' },
  { name: 'Figueroa, Keila', pin: '435147' },
  { name: 'Gomez, Manuel', pin: '788473' },
  { name: 'Hernandez Artu, Omaleyshka', pin: '220503' },
  { name: 'Irizarry Valentin, Bryan', pin: '264780' },
  { name: 'Irizarry, Briana', pin: '573905' },
  { name: 'Jesus, Jonathan', pin: '942596' },
  { name: 'Jomar, Aviles', pin: '785197' },
  { name: 'Laboy Burgos, Genesis', pin: '362654' },
  { name: 'Leon, Ediliz', pin: '871661' },
  { name: 'Medina Martinez, Yadiel', pin: '280922' },
  { name: 'Medina, Kelvin', pin: '478956' },
  { name: 'Morales Barral, Alexa', pin: '962568' },
  { name: 'Morales Santiago, Roberto', pin: '215057' },
  { name: 'Olivera, Yanisse', pin: '316128' },
  { name: 'Oliveros, Angeles', pin: '312328' },
  { name: 'Pabon Santiago, Glennyliz', pin: '786374' },
  { name: 'Pacheco Negron, Tiffany', pin: '16333' },
  { name: 'Perez, Kenned', pin: '968186' },
  { name: 'Reyes Figueroa, Gabriela', pin: '371375' },
  { name: 'Rios Colon, Manuel', pin: '683029' },
  { name: 'Rivera Gonzalez, Jeniel', pin: '731635' },
  { name: 'Rivera Morales, Annel', pin: '630565' },
  { name: 'Rivera Morales, Xavier', pin: '306408' },
  { name: 'Rivera, Axel', pin: '594992' },
  { name: 'Rivera, Ivonne', pin: '260361' },
  { name: 'Rodriguez Rivera, Nicole', pin: '598259' },
  { name: 'Rodriguez, Nashalee', pin: '898719' },
  { name: 'Rolon Torres, Aaliyah', pin: '204347' },
  { name: 'Rosario Bonilla, Mictonio', pin: '155692' },
  { name: 'Rosario, Alana', pin: '536594' },
  { name: 'Ruiz Rodriguez, Marcos', pin: '403842' },
  { name: 'Ruiz, Yan', pin: '111049' },
  { name: 'Ruiz, Yanizmar', pin: '211649' },
  { name: 'Ruperto Justiniano, Glorimar', pin: '555308' },
  { name: 'Ruperto Justiniano, Jonathan', pin: '389144' },
  { name: 'Santiago, Arlene', pin: '739632' },
  { name: 'Serrano, Gabriel', pin: '790027' },
  { name: 'Sosa de Leon, Julian', pin: '391898' },
  { name: 'Sosa De Leon, Julio', pin: '890480' },
  { name: 'Stuart Nazario, Jaileen', pin: '597985' },
  { name: 'Toro Cruz, Aleyshka', pin: '422745' },
  { name: 'Torres Gonzalez, Nelson', pin: '302366' },
  { name: 'Torres Roldan, Suleyka', pin: '912675' },
  { name: 'Ulbinas Algarin, Carmen', pin: '892391' },
  { name: 'Vazquez, Krystal', pin: '112484' },
  { name: 'Velazquez Cintron, Luzmari', pin: '323259' },
  { name: 'Zaragoza Maysonett, Luzaida', pin: '475360' }
];

// Get all employees from DB
const employees = db.prepare('SELECT id, first_name, last_name, full_name, status FROM employees').all();

// Build lookup: normalize names for fuzzy matching
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

const empByNorm = {};
for (const emp of employees) {
  // Try multiple key formats
  const k1 = normalize(emp.first_name + emp.last_name);
  const k2 = normalize(emp.full_name);
  empByNorm[k1] = emp;
  empByNorm[k2] = emp;
}

async function createAccounts() {
  let created = 0;
  let skipped = 0;
  let notFound = [];

  const existingUsers = db.prepare('SELECT username, employee_id FROM users').all();
  const existingPins = new Set(existingUsers.map(u => u.username));
  const linkedEmployees = new Set(existingUsers.map(u => u.employee_id).filter(Boolean));

  for (const entry of pinData) {
    // Parse "LastName, FirstName" format
    const commaIdx = entry.name.indexOf(',');
    const lastName = entry.name.substring(0, commaIdx).trim();
    const firstName = entry.name.substring(commaIdx + 1).trim();

    // Try to find matching employee
    const searchKey = normalize(firstName + lastName);
    let emp = empByNorm[searchKey];

    if (!emp) {
      // Try last_name first_name order
      const searchKey2 = normalize(lastName + firstName);
      emp = empByNorm[searchKey2];
    }

    if (!emp) {
      notFound.push(`${firstName} ${lastName} (PIN: ${entry.pin})`);
      continue;
    }

    // Skip if already has account
    if (linkedEmployees.has(emp.id)) {
      skipped++;
      continue;
    }

    if (existingPins.has(entry.pin)) {
      console.log(`  PIN ${entry.pin} already taken, skipping ${firstName} ${lastName}`);
      skipped++;
      continue;
    }

    // Create account: PIN as username, PIN as temp password, must change
    const password_hash = await bcrypt.hash(entry.pin, 10);
    db.prepare(`
      INSERT INTO users (username, password_hash, role, employee_id, must_change_password)
      VALUES (?, ?, 'employee', ?, 1)
    `).run(entry.pin, password_hash, emp.id);

    console.log(`  Created: ${firstName} ${lastName} → PIN ${entry.pin} (employee #${emp.id})`);
    created++;
    existingPins.add(entry.pin);
    linkedEmployees.add(emp.id);
  }

  console.log(`\nDone: ${created} accounts created, ${skipped} skipped`);
  if (notFound.length > 0) {
    console.log(`\nCould not match ${notFound.length} employees:`);
    notFound.forEach(n => console.log(`  - ${n}`));
  }
}

createAccounts().catch(console.error);
