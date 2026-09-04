import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function jsonEnv(name, fallback = []) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch { throw new Error(`${name} no contiene JSON válido`); }
}

const legacyConfigPath = path.join(__dirname, 'config.json');
const legacyConfig = fs.existsSync(legacyConfigPath) ? JSON.parse(fs.readFileSync(legacyConfigPath, 'utf8')) : {};
const config = {
  companyName: process.env.COMPANY_NAME || legacyConfig.companyName || 'Ibérica Seguridad',
  adminPin: process.env.ADMIN_PIN || legacyConfig.adminPin,
  qrSecret: process.env.QR_SECRET || legacyConfig.qrSecret,
  employees: jsonEnv('EMPLOYEES_JSON', legacyConfig.employees || []),
  locations: jsonEnv('LOCATIONS_JSON', legacyConfig.locations || (legacyConfig.shop ? [legacyConfig.shop] : [])),
};

if (!config.adminPin || !config.qrSecret || !config.employees.length || !config.locations.length) {
  throw new Error('Faltan ADMIN_PIN, QR_SECRET, EMPLOYEES_JSON o LOCATIONS_JSON');
}

const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'fichajes.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  accuracy REAL,
  distance_m REAL,
  inside_radius INTEGER NOT NULL,
  user_agent TEXT,
  note TEXT
)`);

const columns = new Set(db.prepare('PRAGMA table_info(punches)').all().map(column => column.name));
if (!columns.has('location_name')) db.exec('ALTER TABLE punches ADD COLUMN location_name TEXT');

const app = Fastify({ logger: true });
await app.register(formbody);
app.addHook('onRequest', async (_, reply) => reply.header('Cache-Control', 'no-store, max-age=0'));

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const employeeById = id => config.employees.find(employee => employee.id === id);

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function nearestLocation(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return config.locations.map(location => ({
    location,
    distance: distanceMeters(location.latitude, location.longitude, latitude, longitude),
    allowedRadiusMeters: Number(location.allowedRadiusMeters || 120),
  })).sort((a, b) => a.distance - b.distance)[0] || null;
}

const mapsUrl = row => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
  ? `https://www.google.com/maps?q=${Number(row.latitude)},${Number(row.longitude)}` : '';
const displayLocation = row => row.location_name || nearestLocation(Number(row.latitude), Number(row.longitude))?.location?.name || 'Sin ubicación';

function madridParts(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('es-ES', {
    timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  }).formatToParts(new Date(iso)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date:`${parts.day}/${parts.month}/${parts.year}`, time:`${parts.hour}:${parts.minute}:${parts.second}` };
}

function state(employeeId) {
  const last = db.prepare('SELECT kind FROM punches WHERE employee_id = ? AND inside_radius = 1 ORDER BY id DESC LIMIT 1').get(employeeId);
  if (!last || last.kind === 'salida') return 'fuera';
  if (last.kind === 'pausa') return 'pausa';
  return 'dentro';
}

const allowedKinds = current => current === 'fuera' ? ['entrada'] : current === 'pausa' ? ['vuelta','salida'] : ['pausa','salida'];
const stateLabel = current => ({ fuera:'fuera', pausa:'en pausa', dentro:'dentro' }[current] || current);

function layout(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main><section class="card">${body}</section></main></body></html>`;
}

function brand(title, subtitle) {
  return `<div class="brand"><div class="brand-mark">I</div><div><h1>${escapeHtml(title)}</h1><h2>${escapeHtml(subtitle)}</h2></div></div>`;
}

function queryRows(query) {
  const conditions = [];
  const params = [];
  if (query.from) { conditions.push('created_at >= ?'); params.push(`${query.from}T00:00:00.000Z`); }
  if (query.to) { conditions.push('created_at < ?'); const until = new Date(`${query.to}T00:00:00.000Z`); until.setUTCDate(until.getUTCDate() + 1); params.push(until.toISOString()); }
  if (query.employee) { conditions.push('employee_id = ?'); params.push(query.employee); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM punches${where} ORDER BY created_at ASC, id ASC`).all(...params);
}

app.get('/', async (req, reply) => {
  const qrOk = req.query.qr === config.qrSecret;
  const selected = employeeById(req.query.employee) || config.employees[0];
  const current = state(selected.id);
  const allowed = allowedKinds(current);
  const options = config.employees.map(employee => `<option value="${escapeHtml(employee.id)}"${employee.id === selected.id ? ' selected' : ''}>${escapeHtml(employee.name)}</option>`).join('');
  const button = (kind, label) => `<button name="kind" value="${kind}"${allowed.includes(kind) ? '' : ' disabled'}>${label}</button>`;
  reply.type('text/html').send(layout(config.companyName, `${brand('Control horario', config.companyName)}
    <p class="muted">Estado actual: <strong id="stateText">${stateLabel(current)}</strong></p>
    <p class="status ${qrOk ? 'success' : 'warning'}">${qrOk ? 'QR del centro detectado' : 'Abre esta pantalla desde el QR del centro.'}</p>
    <form id="punchForm" method="post" action="/punch">
      <input type="hidden" name="qr" value="${qrOk ? escapeHtml(config.qrSecret) : ''}"><input type="hidden" name="latitude" id="latitude"><input type="hidden" name="longitude" id="longitude"><input type="hidden" name="accuracy" id="accuracy">
      <label for="employeeId">Trabajador</label><select name="employeeId" id="employeeId" required>${options}</select>
      <label for="pin">PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required>
      <div class="buttons">${button('entrada','Entrada')}${button('salida','Salida')}${button('pausa','Pausa')}${button('vuelta','Vuelta')}</div>
      <p id="gps" class="status">Solicitando ubicación…</p>
    </form><p class="small"><a href="/admin">Panel de administración</a></p><script src="/app.js"></script>`));
});

app.get('/state/:employeeId', async (req, reply) => {
  const employee = employeeById(req.params.employeeId);
  if (!employee) return reply.code(404).send({ error:'Trabajador no encontrado' });
  const current = state(employee.id);
  return { state:current, label:stateLabel(current), allowed:allowedKinds(current) };
});

app.post('/punch', async (req, reply) => {
  const { employeeId, pin, kind, latitude, longitude, accuracy, qr } = req.body || {};
  const employee = employeeById(employeeId);
  const back = `/?qr=${encodeURIComponent(qr === config.qrSecret ? config.qrSecret : '')}&employee=${encodeURIComponent(employeeId || '')}`;
  if (!employee || employee.pin !== pin) return reply.code(401).type('text/html').send(layout('Error', `${brand('PIN incorrecto', config.companyName)}<a class="button" href="${back}">Volver</a>`));
  if (qr !== config.qrSecret) return reply.code(403).type('text/html').send(layout('Error', `${brand('QR no válido', config.companyName)}<p>Para fichar debes abrir el enlace desde el QR físico.</p><a class="button" href="/">Volver</a>`));
  if (!['entrada','salida','pausa','vuelta'].includes(kind) || !allowedKinds(state(employee.id)).includes(kind)) return reply.code(409).type('text/html').send(layout('Error', `${brand('Fichaje no permitido', config.companyName)}<p>La secuencia de fichajes no es válida.</p><a class="button" href="${back}">Volver</a>`));

  const lat = Number(latitude), lon = Number(longitude), acc = Number(accuracy || 9999);
  const nearest = nearestLocation(lat, lon);
  if (!nearest) return reply.code(400).type('text/html').send(layout('Error', `${brand('Ubicación no válida', config.companyName)}<a class="button" href="${back}">Volver</a>`));
  const inside = nearest.distance <= nearest.allowedRadiusMeters;
  const note = inside ? '' : 'Rechazado: fuera del radio permitido';
  db.prepare(`INSERT INTO punches (employee_id,employee_name,kind,created_at,latitude,longitude,accuracy,distance_m,inside_radius,user_agent,note,location_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    employee.id, employee.name, kind, new Date().toISOString(), lat, lon, acc, nearest.distance, inside ? 1 : 0, req.headers['user-agent'] || '', note, nearest.location.name
  );
  if (!inside) return reply.code(403).type('text/html').send(layout('Fuera del centro', `${brand('Fichaje rechazado', config.companyName)}<p>Estás a ${Math.round(nearest.distance)} m de ${escapeHtml(nearest.location.name)}. El máximo permitido es ${nearest.allowedRadiusMeters} m.</p><a class="button" href="${back}">Volver</a>`));
  return reply.type('text/html').send(layout('Fichaje registrado', `${brand('Fichaje registrado', employee.name)}<p class="status success">${escapeHtml(kind)} · ${escapeHtml(nearest.location.name)} · ${madridParts(new Date().toISOString()).time}</p><a class="button" href="${back}">Volver</a>`));
});

app.get('/admin', async (req, reply) => {
  if (req.query.pin !== config.adminPin) return reply.type('text/html').send(layout('Administración', `${brand('Administración', config.companyName)}<form><label for="pin">PIN de administración</label><input id="pin" name="pin" type="password" inputmode="numeric" required><button type="submit">Entrar</button></form>`));
  const rows = queryRows(req.query).slice(-500).reverse();
  const params = new URLSearchParams({ pin:config.adminPin });
  for (const key of ['from','to','employee']) if (req.query[key]) params.set(key, req.query[key]);
  const options = ['<option value="">Todos</option>', ...config.employees.map(employee => `<option value="${escapeHtml(employee.id)}"${req.query.employee === employee.id ? ' selected' : ''}>${escapeHtml(employee.name)}</option>`)].join('');
  const tableRows = rows.map(row => { const parts = madridParts(row.created_at); return `<tr><td>${parts.date}</td><td>${parts.time}</td><td>${escapeHtml(row.employee_name)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(displayLocation(row))}</td><td>${Math.round(row.distance_m || 0)} m</td><td>${row.inside_radius ? 'Válido' : 'Rechazado'}</td><td><a href="${mapsUrl(row)}" target="_blank" rel="noopener">Mapa</a></td></tr>`; }).join('');
  reply.type('text/html').send(layout('Administración', `${brand('Registro horario', config.companyName)}
    <form class="filters"><input type="hidden" name="pin" value="${escapeHtml(config.adminPin)}"><label>Desde<input type="date" name="from" value="${escapeHtml(req.query.from || '')}"></label><label>Hasta<input type="date" name="to" value="${escapeHtml(req.query.to || '')}"></label><label>Trabajador<select name="employee">${options}</select></label><button type="submit">Aplicar filtros</button></form>
    <div class="actions"><a class="button" href="/export.xlsx?${params}">Exportar Excel</a><a class="button secondary" href="/export.csv?${params}">Exportar CSV</a></div>
    <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Hora</th><th>Trabajador</th><th>Tipo</th><th>Lugar</th><th>Distancia</th><th>Validación</th><th>Mapa</th></tr></thead><tbody>${tableRows}</tbody></table></div>`));
});

function authoriseExport(req, reply) {
  if (req.query.pin !== config.adminPin) { reply.code(401).send('PIN incorrecto'); return false; }
  return true;
}

app.get('/export.csv', async (req, reply) => {
  if (!authoriseExport(req, reply)) return;
  const header = ['fecha','hora','trabajador','tipo_fichaje','lugar','latitud','longitud','precision_m','distancia_centro_m','validacion','observaciones','maps_url'];
  const esc = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  const lines = queryRows(req.query).map(row => { const parts = madridParts(row.created_at); return [parts.date,parts.time,row.employee_name,row.kind,displayLocation(row),row.latitude,row.longitude,row.accuracy,Math.round(row.distance_m || 0),row.inside_radius ? 'Válido' : 'Rechazado',row.note,mapsUrl(row)].map(esc).join(';'); });
  reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="registro-horario-iberica.csv"').send(`\uFEFF${header.join(';')}\n${lines.join('\n')}`);
});

function calculateSummary(rows) {
  const groups = new Map();
  for (const row of rows.filter(item => item.inside_radius)) {
    if (!groups.has(row.employee_id)) groups.set(row.employee_id,{ name:row.employee_name, punches:0, milliseconds:0, incomplete:0, shiftOpen:false, activeSince:null });
    const summary = groups.get(row.employee_id); summary.punches++;
    const moment = new Date(row.created_at).getTime();
    if (row.kind === 'entrada') {
      if (summary.shiftOpen) summary.incomplete++;
      summary.shiftOpen = true; summary.activeSince = moment;
    } else if (row.kind === 'pausa' && summary.shiftOpen && summary.activeSince !== null) {
      summary.milliseconds += moment - summary.activeSince; summary.activeSince = null;
    } else if (row.kind === 'vuelta' && summary.shiftOpen && summary.activeSince === null) {
      summary.activeSince = moment;
    } else if (row.kind === 'salida' && summary.shiftOpen) {
      if (summary.activeSince !== null) summary.milliseconds += moment - summary.activeSince;
      summary.shiftOpen = false; summary.activeSince = null;
    } else summary.incomplete++;
  }
  for (const summary of groups.values()) if (summary.shiftOpen) summary.incomplete++;
  return [...groups.values()];
}

app.get('/export.xlsx', async (req, reply) => {
  if (!authoriseExport(req, reply)) return;
  const rows = queryRows(req.query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = config.companyName;
  workbook.created = new Date();
  const detail = workbook.addWorksheet('Fichajes',{ views:[{ state:'frozen', ySplit:5 }] });
  detail.mergeCells('A1:L1'); detail.getCell('A1').value = `Registro horario · ${config.companyName}`;
  detail.getCell('A1').font = { bold:true, size:18, color:{argb:'FF1E8A2E'} };
  const firstDate = rows[0]?.created_at ? madridParts(rows[0].created_at).date : 'Sin datos';
  const lastDate = rows.at(-1)?.created_at ? madridParts(rows.at(-1).created_at).date : 'Sin datos';
  detail.mergeCells('A2:L2'); detail.getCell('A2').value = `Periodo: ${firstDate} – ${lastDate}`;
  detail.mergeCells('A3:L3'); detail.getCell('A3').value = `Generado: ${madridParts(new Date().toISOString()).date} ${madridParts(new Date().toISOString()).time}`;
  const headers = ['Fecha','Hora','Trabajador','Tipo de fichaje','Centro o lugar','Latitud','Longitud','Precisión GPS','Distancia al centro','Validación','Observaciones','Ver en Google Maps'];
  detail.addRow([]); detail.addRow(headers);
  const headerRow = detail.getRow(5); headerRow.font={bold:true,color:{argb:'FFFFFFFF'}}; headerRow.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E8A2E'}}; headerRow.alignment={vertical:'middle'};
  for (const row of rows) { const parts=madridParts(row.created_at); const added=detail.addRow([parts.date,parts.time,row.employee_name,row.kind,displayLocation(row),row.latitude,row.longitude,row.accuracy,Math.round(row.distance_m||0),row.inside_radius?'Válido':'Rechazado',row.note||'',{text:'Abrir mapa',hyperlink:mapsUrl(row)}]); if (!row.inside_radius) added.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE7E7'}}; }
  detail.autoFilter={from:{row:5,column:1},to:{row:5,column:12}};
  [12,11,22,18,42,13,13,15,20,15,32,20].forEach((width,index)=>{detail.getColumn(index+1).width=width;});
  detail.eachRow((row,rowNumber)=>{ if(rowNumber>=5){row.alignment={vertical:'top',wrapText:true};row.height=20;} });
  detail.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,paperSize:9};
  detail.headerFooter.oddFooter='Página &P de &N';

  const summarySheet = workbook.addWorksheet('Resumen',{views:[{state:'frozen',ySplit:3}]});
  summarySheet.mergeCells('A1:D1'); summarySheet.getCell('A1').value=`Resumen · ${config.companyName}`; summarySheet.getCell('A1').font={bold:true,size:18,color:{argb:'FF1E8A2E'}};
  summarySheet.addRow([]); summarySheet.addRow(['Trabajador','Fichajes válidos','Horas calculadas','Incidencias de secuencia']);
  const summaryHeader=summarySheet.getRow(3); summaryHeader.font={bold:true,color:{argb:'FFFFFFFF'}}; summaryHeader.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E8A2E'}};
  for (const item of calculateSummary(rows)) summarySheet.addRow([item.name,item.punches,item.milliseconds/86400000,item.incomplete ? `${item.incomplete} · revisar fichajes` : 'Sin incidencias']);
  summarySheet.getColumn(3).numFmt='[h]:mm'; [28,20,20,30].forEach((width,index)=>{summarySheet.getColumn(index+1).width=width;});
  const buffer=await workbook.xlsx.writeBuffer();
  reply.header('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition','attachment; filename="registro-horario-iberica.xlsx"').send(Buffer.from(buffer));
});

app.get('/health', async () => ({ ok:true }));
app.get('/style.css', async (_,reply)=>reply.type('text/css').send(fs.readFileSync(path.join(__dirname,'public','style.css'),'utf8')));
app.get('/app.js', async (_,reply)=>reply.type('application/javascript').send(fs.readFileSync(path.join(__dirname,'public','app.js'),'utf8')));

const port=Number(process.env.PORT || 3050);
await app.listen({port,host:'0.0.0.0'});
