// ═══════════════════════════════════════════════════════════════════════════
// S&O PLANMODULE — BAM Wood Concepts
//
// Architectuur (voorbereid op backend):
//   • BRONDATA  = read-only JSON exports (S&O meldingen + oplospunten).
//     Wordt bij iedere sessie opnieuw ingeladen en NIET lokaal bewaard.
//   • PLANDATA  = alles wat de afdeling zelf registreert (werkstatus, prio,
//     behandelaar, acties, notities). Gekoppeld op een stabiel item-ID.
//     Opslag: localStorage ('so_plan_v1') + export/import als JSON.
//     Dit JSON-schema is één-op-één het datamodel voor de latere backend:
//       PUT  /workitems/{id}/plan      → planstore.items[id]
//       POST /workitems/{id}/acties    → planstore.items[id].acties[]
//       GET  /team                     → planstore.team
// ═══════════════════════════════════════════════════════════════════════════

// ── Vaste definities ────────────────────────────────────────────────────────
var WERKSTATUS = [
  { key: 'nieuw',      label: 'Nieuw',            color: 'var(--st-nieuw)',      hex: '#64748b' },
  { key: 'beoordeeld', label: 'Beoordeeld',       color: 'var(--st-beoordeeld)', hex: '#0ea5e9' },
  { key: 'gepland',    label: 'Gepland',          color: 'var(--st-gepland)',    hex: '#2563eb' },
  { key: 'uitvoering', label: 'In uitvoering',    color: 'var(--st-uitvoering)', hex: '#7c3aed' },
  { key: 'wachten',    label: 'Wacht op derden',  color: 'var(--st-wachten)',    hex: '#d97706' },
  { key: 'gereed',     label: 'Gereed',           color: 'var(--st-gereed)',     hex: '#16a34a' },
  { key: 'gesloten',   label: 'Gesloten',         color: 'var(--st-gesloten)',   hex: '#94a3b8' }
];
var PRIORITEIT = [
  { key: 'spoed',   label: 'Spoed',   hex: '#dc2626' },
  { key: 'hoog',    label: 'Hoog',    hex: '#ea580c' },
  { key: 'normaal', label: 'Normaal', hex: '#2563eb' },
  { key: 'laag',    label: 'Laag',    hex: '#64748b' }
];
// Oorzaak = kostensoort (hoofdgroep) + optioneel een specifieke oorzaak daaronder.
// Opslagformaat: 'groepKey' of 'groepKey|Specifieke oorzaak' (bv. 'faalkosten|Montagefout').
// De oorzaken die vroeger los bestonden hangen nu onder Faalkosten; oude plandata
// wordt bij het laden automatisch gemigreerd (zie migreerOorzaken).
var OORZAAK_GROEPEN = [
  { key: 'faalkosten',     label: 'Faalkosten',     hex: '#dc2626',
    subs: ['Productiefout', 'Montagefout', 'Transportschade', 'Ontwerpfout', 'Materiaalfout', 'Leverancier', 'Gebruik / bewoner', 'Onderhoud regulier', 'Onbekend'] },
  { key: 'opdrachtkosten', label: 'Opdrachtkosten', hex: '#2563eb', subs: [] },
  { key: 'meerwerk',       label: 'Meerwerk',       hex: '#7c3aed', subs: [] },
  { key: 'garantiekosten', label: 'Garantiekosten', hex: '#d97706', subs: [] }
];
// Oude (ongegroepeerde) waarden — alleen nog nodig voor de migratie naar Faalkosten.
var LEGACY_OORZAKEN = ['Productiefout', 'Montagefout', 'Transportschade', 'Ontwerpfout', 'Materiaalfout', 'Leverancier', 'Gebruik / bewoner', 'Onderhoud regulier', 'Onbekend'];
var OPLOSSINGEN = ['', 'Herstellen op locatie', 'Onderdeel vervangen', 'Nalevering', 'Afstellen', 'Schilderwerk / kitwerk', 'Uitbesteden aan derden', 'Geen actie nodig', 'Doorverwijzen (niet BWC)'];
var OPLOS_ALLOWED_ORGS = ['BAM Wood Concepts B.V.', 'BWC - Leveranciers'];
var STORAGE_KEY = 'so_plan_v1';

// Standaard doorlooptijd (dagen na aanmaak) waarbinnen een item afgehandeld moet zijn.
// Instelbaar door de gebruiker; opgeslagen in planstore.settings.
// faseMax = hoeveel dagen een taak maximaal in die kolom van het planbord mag
// staan (0 = geen limiet). Overschrijding verschijnt in de tab Te laat en op
// het weekstartbord.
var DEFAULT_SETTINGS = {
  deadlineOl: 30,
  deadlineSo: 14,
  faseMax: { nieuw: 7, beoordeeld: 7, gepland: 14, uitvoering: 7, wachten: 21, gereed: 7, gesloten: 0 }
};

// ── State ───────────────────────────────────────────────────────────────────
var sourceItems = { so: [], ol: [] };   // genormaliseerde brondata
var workItems   = [];                    // gecombineerde werkvoorraad (incl. verweesde planitems)
var planstore   = { version: 1, items: {}, team: [], taken: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
var selections  = { 'ms-bron': new Set(), 'ms-bedrijf': new Set(), 'ms-project': new Set(), 'ms-nummer': new Set(), 'ms-status': new Set(), 'ms-behandelaar': new Set(), 'ms-prio': new Set() };
var sortField = 'aangemaakt', sortDir = -1;
var drawerId = null;
var groupByProject = { planbord: false };
var takenOpen = new Set();      // ID's van uitgeklapte taakkaarten (alleen in sessie)
var openProjecten = new Set();  // uitgeklapte projectfamilies in de werkvoorraad (alleen in sessie)
var wvSelected = new Set();     // aangevinkte items voor bulkacties in de werkvoorraad
var planbordBehandelaar = '';   // planbord-filter: '' = iedereen
// Concepten in de bulkbalk — bewaard zodat een herrender de invoer niet wist.
var bulkBehDraft = '', bulkCodeDraft = '', bulkTaakDraft = '';

// ── Helpers ─────────────────────────────────────────────────────────────────
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }
function hashId(s) { // djb2
  var h = 5381;
  for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}
function todayISO() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function nowStamp() { var d = new Date(); return formatDate(d) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
function formatDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return String(d.getDate()).padStart(2,'0') + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + d.getFullYear();
}
function formatISO(iso) { if (!iso) return '—'; var p = iso.split('-'); return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : iso; }
var MONTHS = { jan:0, feb:1, mar:2, mrt:2, apr:3, may:4, mei:4, jun:5, jul:6, aug:7, sep:8, oct:9, okt:9, nov:10, dec:11 };
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  var d = new Date(s);
  if (!isNaN(d)) return d;
  var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function stDef(key) { for (var i = 0; i < WERKSTATUS.length; i++) if (WERKSTATUS[i].key === key) return WERKSTATUS[i]; return WERKSTATUS[0]; }

// Streefdatum = aanmaakdatum + ingestelde doorlooptijd per bron.
// "te laat" kijkt naar deze moet-klaar-datum (niet naar de handmatige planning).
function deadlineDays(bron) {
  var s = planstore.settings || DEFAULT_SETTINGS;
  return bron === 'ol' ? (s.deadlineOl || DEFAULT_SETTINGS.deadlineOl) : (s.deadlineSo || DEFAULT_SETTINGS.deadlineSo);
}
function streefDatum(it) {
  if (!it.aangemaakt) return null;
  var d = new Date(it.aangemaakt.getTime());
  d.setDate(d.getDate() + deadlineDays(it.bron));
  d.setHours(0, 0, 0, 0);
  return d;
}
function isTeLaat(it, plan) {
  var ws = plan ? plan.werkstatus : 'nieuw';
  if (ws === 'gereed' || ws === 'gesloten') return false;
  var sd = streefDatum(it);
  if (!sd) return false;
  var now = new Date(); now.setHours(0, 0, 0, 0);
  return sd < now;
}
function dagenTeLaat(it) {
  var sd = streefDatum(it);
  if (!sd) return 0;
  var now = new Date(); now.setHours(0, 0, 0, 0);
  return daysBetween(sd, now);
}
function prioDef(key) { for (var i = 0; i < PRIORITEIT.length; i++) if (PRIORITEIT[i].key === key) return PRIORITEIT[i]; return PRIORITEIT[2]; }

// ── Doorlooptijd per planbordfase ───────────────────────────────────────────
// Taken én meldingen houden bij hoeveel tijd ze in elke werkstatus hebben
// gestaan:  statusTijd = { statusKey: seconden }  +  statusSinds = ISO-tijdstip
// van de laatste statuswissel. De tijd in de huidige fase telt live door, dus
// je ziet altijd hoe lang iets al in die kolom van het planbord staat.
function nowIso() { return new Date().toISOString(); }
function secSinds(iso) {
  if (!iso) return 0;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
}
// Sluit de lopende fase af en start de klok voor de nieuwe fase.
function boekStatusTijd(obj, oudeStatus) {
  if (!obj.statusTijd) obj.statusTijd = {};
  if (obj.statusSinds) obj.statusTijd[oudeStatus] = (obj.statusTijd[oudeStatus] || 0) + secSinds(obj.statusSinds);
  obj.statusSinds = nowIso();
}
// Werkstatus van een planitem wijzigen mét tijdregistratie.
function zetWerkstatus(plan, nieuweStatus) {
  if (plan.werkstatus === nieuweStatus) return false;
  boekStatusTijd(plan, plan.werkstatus);
  plan.werkstatus = nieuweStatus;
  return true;
}
// Geboekte tijd + de tijd die nu in de huidige fase loopt.
function statusTijdNu(obj, huidigeStatus) {
  var uit = {};
  var basis = (obj && obj.statusTijd) || {};
  Object.keys(basis).forEach(function (k) { uit[k] = basis[k]; });
  if (obj && obj.statusSinds) uit[huidigeStatus] = (uit[huidigeStatus] || 0) + secSinds(obj.statusSinds);
  return uit;
}
function taakStatusTijd(t) { return statusTijdNu(t, t.status); }
// Maximale tijd (in dagen) voor een fase; 0/leeg = geen limiet.
function faseMaxDagen(statusKey) {
  var m = (planstore.settings && planstore.settings.faseMax) || DEFAULT_SETTINGS.faseMax;
  var n = parseInt(m[statusKey], 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
// Hoe ver zit een taak over de limiet van zijn huidige fase? Geeft null als
// er geen limiet is of als hij er nog binnen valt.
function faseOverschrijding(t) {
  var maxDagen = faseMaxDagen(t.status);
  if (!maxDagen) return null;
  var inFase = secSinds(t.statusSinds);
  var overSec = inFase - maxDagen * 86400;
  if (overSec <= 0) return null;
  return { inFase: inFase, maxDagen: maxDagen, over: overSec };
}
// Alle taken die te lang in hun fase staan, langst eerst.
function takenTeLangInFase(alleenMetKinderen) {
  return planstore.taken.filter(function (t) {
    if (alleenMetKinderen && !t.kinderen.length) return false;
    return !!faseOverschrijding(t);
  }).map(function (t) {
    var o = faseOverschrijding(t);
    return { taak: t, inFase: o.inFase, maxDagen: o.maxDagen, over: o.over };
  }).sort(function (a, b) { return b.over - a.over; });
}
// Voor een melding/oplospunt. Zonder plandata staat het item sinds de
// aanmaakdatum in de bron onafgebroken op 'nieuw'.
function itemStatusTijd(it) {
  var plan = getPlan(it.id);
  if (plan) return statusTijdNu(plan, plan.werkstatus);
  var uit = {};
  if (it.aangemaakt) uit.nieuw = Math.max(0, Math.round((Date.now() - it.aangemaakt.getTime()) / 1000));
  return uit;
}
function somTijd(map) {
  var n = 0;
  Object.keys(map).forEach(function (k) { n += map[k] || 0; });
  return n;
}
function formatDuur(sec) {
  sec = Math.round(sec || 0);
  if (sec <= 0) return '—';
  var d = Math.floor(sec / 86400), u = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 1) return d + ' d' + (u ? ' ' + u + ' u' : '');
  if (u >= 1) return u + ' u' + (m ? ' ' + m + ' m' : '');
  return Math.max(1, m) + ' m';
}
// Gestapelde balk die laat zien hoe de doorlooptijd over de fasen verdeeld is.
function faseBalkHtml(tijd, breedtePct) {
  var totaal = somTijd(tijd);
  if (!totaal) return '<span class="fase-leeg">—</span>';
  var stijl = breedtePct === undefined ? '' : ' style="width:' + Math.max(2, breedtePct).toFixed(2) + '%"';
  return '<div class="fase-balk"' + stijl + '>' + WERKSTATUS.filter(function (st) { return tijd[st.key]; }).map(function (st) {
    return '<span style="width:' + (tijd[st.key] / totaal * 100).toFixed(2) + '%;background:' + st.hex + '"'
      + ' title="' + escHtml(st.label + ': ' + formatDuur(tijd[st.key])) + '"></span>';
  }).join('') + '</div>';
}
// Leesbare opsomming "Nieuw 3 d · Gepland 5 u"
function faseLijstHtml(tijd) {
  var rijen = WERKSTATUS.filter(function (st) { return tijd[st.key]; });
  if (!rijen.length) return '<div class="agenda-leeg">Nog geen doorlooptijd geregistreerd.</div>';
  return '<div class="fase-lijst">' + rijen.map(function (st) {
    return '<div class="fase-regel"><span class="st-dot" style="background:' + st.hex + '"></span>'
      + '<span class="fase-naam">' + escHtml(st.label) + '</span>'
      + '<span class="fase-duur">' + formatDuur(tijd[st.key]) + '</span></div>';
  }).join('') + '</div>';
}

// ── Oorzaak / kostensoort ───────────────────────────────────────────────────
function oorzaakGroepDef(key) {
  for (var i = 0; i < OORZAAK_GROEPEN.length; i++) if (OORZAAK_GROEPEN[i].key === key) return OORZAAK_GROEPEN[i];
  return null;
}
// 'faalkosten|Montagefout' → { groep: 'faalkosten', sub: 'Montagefout' }
function splitOorzaak(v) {
  v = v || '';
  var i = v.indexOf('|');
  return i === -1 ? { groep: v, sub: '' } : { groep: v.slice(0, i), sub: v.slice(i + 1) };
}
function oorzaakGroepLabel(v) {
  var g = oorzaakGroepDef(splitOorzaak(v).groep);
  return g ? g.label : (splitOorzaak(v).groep || '');
}
function oorzaakGroepHex(v) {
  var g = oorzaakGroepDef(splitOorzaak(v).groep);
  return g ? g.hex : '#64748b';
}
function oorzaakLabel(v) {
  var p = splitOorzaak(v);
  if (!p.groep) return '';
  var g = oorzaakGroepDef(p.groep);
  var label = g ? g.label : p.groep;
  return p.sub ? label + ' — ' + p.sub : label;
}
// Select-inhoud: hoofdgroepen met specifieke oorzaken krijgen een optgroup,
// hoofdgroepen zonder specificatie zijn gewoon één keuze.
function oorzaakOptionsHtml(current) {
  var html = '<option value=""' + (!current ? ' selected' : '') + '>—</option>';
  OORZAAK_GROEPEN.forEach(function (g) {
    if (!g.subs.length) {
      html += '<option value="' + g.key + '"' + (current === g.key ? ' selected' : '') + '>' + escHtml(g.label) + '</option>';
      return;
    }
    html += '<optgroup label="' + escAttr(g.label) + '">';
    html += '<option value="' + g.key + '"' + (current === g.key ? ' selected' : '') + '>' + escHtml(g.label) + ' — algemeen</option>';
    g.subs.forEach(function (sub) {
      var v = g.key + '|' + sub;
      html += '<option value="' + escAttr(v) + '"' + (current === v ? ' selected' : '') + '>' + escHtml(sub) + '</option>';
    });
    html += '</optgroup>';
  });
  return html;
}
// Bestaande plandata kent nog geen doorlooptijd: we starten de klok. Een item
// dat nog op 'nieuw' staat, staat daar sinds de aanmaakdatum in de bron; voor
// een taak nemen we de aanmaakdatum van de taak.
function migreerDoorlooptijd() {
  var n = 0;
  Object.keys(planstore.items).forEach(function (id) {
    var plan = planstore.items[id];
    if (!plan || plan.statusSinds) return;
    if (!plan.statusTijd) plan.statusTijd = {};
    var start = null;
    if (plan.werkstatus === 'nieuw' && plan.snapshot && plan.snapshot.aangemaakt) start = parseDate(plan.snapshot.aangemaakt);
    plan.statusSinds = (start && !isNaN(start.getTime())) ? start.toISOString() : nowIso();
    n++;
  });
  planstore.taken.forEach(function (t) {
    if (typeof t.projectnummer !== 'string') t.projectnummer = '';
    if (typeof t.afgerondOp !== 'string') t.afgerondOp = '';
    if (!Array.isArray(t.oorzaken)) t.oorzaken = [];
    if (!t.werkelijkeUren || typeof t.werkelijkeUren !== 'object') t.werkelijkeUren = {};
    if (typeof t.urenGeregistreerdOp !== 'string') t.urenGeregistreerdOp = '';
    if (t.statusSinds) return;
    if (!t.statusTijd) t.statusTijd = {};
    var start = t.aangemaakt ? parseDate(t.aangemaakt) : null;
    t.statusSinds = (start && !isNaN(start.getTime())) ? start.toISOString() : nowIso();
    n++;
  });
  return n;
}

// Oude losse oorzaken ('Montagefout') worden Faalkosten-specificaties.
function migreerOorzaken() {
  var gewijzigd = 0;
  Object.keys(planstore.items).forEach(function (id) {
    var plan = planstore.items[id];
    if (!plan || !plan.oorzaak || typeof plan.oorzaak !== 'string') return;
    if (plan.oorzaak.indexOf('|') !== -1 || oorzaakGroepDef(plan.oorzaak)) return;
    if (LEGACY_OORZAKEN.indexOf(plan.oorzaak) === -1) return;
    plan.oorzaak = 'faalkosten|' + plan.oorzaak;
    gewijzigd++;
  });
  return gewijzigd;
}
function findField(obj, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (obj[candidates[i]] !== undefined && obj[candidates[i]] !== null) return String(obj[candidates[i]]);
  }
  return '';
}

// ── Opslag (localStorage) ───────────────────────────────────────────────────
function loadStore() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.items) planstore = parsed;
    }
  } catch (e) { console.warn('Kon plandata niet laden:', e); }
  if (!Array.isArray(planstore.team)) planstore.team = [];
  if (!Array.isArray(planstore.taken)) planstore.taken = [];
  planstore.settings = Object.assign({}, DEFAULT_SETTINGS, planstore.settings || {});
  planstore.settings.faseMax = Object.assign({}, DEFAULT_SETTINGS.faseMax, planstore.settings.faseMax || {});
  var gemigreerd = migreerOorzaken() + migreerDoorlooptijd();
  if (gemigreerd) saveStore();
}
function saveStore() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(planstore)); }
  catch (e) { alert('Opslaan mislukt (localStorage vol?). Exporteer je plandata als back-up.'); }
  updateStorageInfo();
}
function getPlan(id) { return planstore.items[id] || null; }
function ensurePlan(item) {
  if (!planstore.items[item.id]) {
    planstore.items[item.id] = {
      werkstatus: 'nieuw', prio: 'normaal', behandelaar: '', gepland: '', uren: '',
      oorzaak: '', oplossing: '', acties: [], notities: [],
      historie: [{ ts: nowStamp(), tekst: 'Item aangemaakt in planmodule' }],
      bronGesloten: false,
      // Doorlooptijd: het item staat sinds de aanmaakdatum in de bron op 'nieuw'
      statusTijd: {},
      statusSinds: (item.aangemaakt && !isNaN(item.aangemaakt.getTime())) ? item.aangemaakt.toISOString() : nowIso(),
      snapshot: { bron: item.bron, nummer: item.nummer, project: item.project, bedrijf: item.bedrijf, omschrijving: item.omschrijving, hyperlink: item.hyperlink, aangemaakt: item.aangemaaktRaw }
    };
  }
  return planstore.items[item.id];
}
function logHist(plan, tekst) {
  plan.historie.push({ ts: nowStamp(), tekst: tekst });
  if (plan.historie.length > 100) plan.historie = plan.historie.slice(-100);
}

// ── Brondata inladen ────────────────────────────────────────────────────────
document.getElementById('file-input-so').addEventListener('change', function (e) {
  readJsonFile(e.target.files[0], 'file-name-so', function (raw) {
    processSO(Array.isArray(raw) ? raw : [raw]);
  });
});
document.getElementById('file-input-ol').addEventListener('change', function (e) {
  readJsonFile(e.target.files[0], 'file-name-ol', function (raw) {
    processOL(Array.isArray(raw) ? raw : [raw]);
  });
});
document.getElementById('file-input-plan').addEventListener('change', function (e) {
  readJsonFile(e.target.files[0], null, function (raw) { importPlanData(raw); });
});
function readJsonFile(file, labelId, cb) {
  if (!file) return;
  if (labelId) document.getElementById(labelId).textContent = file.name;
  var reader = new FileReader();
  reader.onload = function (ev) {
    try { cb(JSON.parse(ev.target.result)); }
    catch (ex) { alert('Kon JSON niet lezen: ' + ex.message); }
  };
  reader.readAsText(file, 'UTF-8');
}

// S&O meldingen (Bhome service-requests export)
function processSO(arr) {
  sourceItems.so = arr.map(function (row) {
    var nummer       = findField(row, ['Serviceverzoek nummer', 'group']);
    var hyperlink    = findField(row, ['Hyperlink', 'group_series_0']);
    var project      = findField(row, ['Project', 'group_series_1']);
    var aangemaakt   = findField(row, ['Aangemaakt op', 'group_series_2']);
    var fase         = findField(row, ['Fase', 'group_series_3']);
    var status       = findField(row, ['Actie status', 'Status', 'group_series_4']);
    var omschrijving = findField(row, ['Omschrijving', 'group_series_6']);
    var bedrijf      = findField(row, ['Bedrijf', 'group_series_7']);
    var categorie    = findField(row, ['Categorie', 'group_series_8']);
    // group_series_9 is de adrescode (bv. KEESVANSPRONSENLAAN36) — bevat straat + huisnummer
    // in één geconcateneerde uppercase-string. We slaan hem op als projectcode én
    // parseren hem tot een leesbaar adres.
    var projectcode  = findField(row, ['Projectcode', 'group_series_9']);
    var bouwnummer   = findField(row, ['Bouwnummer', 'group_series_10']);
    var adres        = findField(row, ['Adres']) || parseAdresCode(projectcode);
    return {
      id: 'so-' + hashId('so|' + nummer + '|' + aangemaakt + '|' + omschrijving.slice(0, 60)),
      bron: 'so', nummer: nummer, hyperlink: hyperlink, project: project,
      aangemaaktRaw: aangemaakt, aangemaakt: parseDate(aangemaakt),
      fase: fase, bronStatus: status, omschrijving: omschrijving,
      bedrijf: bedrijf, categorie: categorie, projectcode: projectcode,
      bouwnummer: bouwnummer, ruimte: '', adres: adres
    };
  });
  rebuildWorkItems();
}

// Oplospunten (Bhome snag export)
function processOL(arr) {
  sourceItems.ol = arr.map(function (row) {
    var hyperlink    = findField(row, ['Hyperlink', 'group']);
    var aangemaakt   = findField(row, ['Aanmaakdatum', 'group_series_0']);
    var auteur       = findField(row, ['Auteur', 'group_series_1']);
    var wbNummer     = findField(row, ['WB nummer', 'group_series_2']);
    var project      = findField(row, ['Project', 'group_series_3']);
    var omschrijving = findField(row, ['Omschrijving', 'group_series_4']);
    var ruimte       = findField(row, ['Ruimte', 'group_series_5']);
    var status       = findField(row, ['Status', 'group_series_6']);
    var organisatie  = findField(row, ['Organisatie', 'group_series_8']);
    // group_series_9 is een vaste label-waarde ("subArea") — geen data.
    // De adres-, bouwnummer- en bedrijf-velden staan één positie verder dan
    // eerder gedacht: 10=straat, 11=huisnummer, 12=bouwnummer, 13=bedrijf.
    var straat       = findField(row, ['Straat', 'group_series_10']);
    var huisnr       = findField(row, ['Huisnummer', 'group_series_11']);
    var toevoeging   = findField(row, ['Toevoeging']);
    var bouwnummer   = findField(row, ['Bouwnummer', 'group_series_12']);
    var bedrijf      = findField(row, ['Bedrijf', 'group_series_13']);
    var adres = [straat, huisnr, toevoeging].filter(Boolean).join(' ');
    return {
      id: 'ol-' + hashId('ol|' + project + '|' + aangemaakt + '|' + omschrijving.slice(0, 80) + '|' + adres + '|' + bouwnummer),
      bron: 'ol', nummer: wbNummer || ('OL ' + (bouwnummer || '')), hyperlink: hyperlink,
      project: project, aangemaaktRaw: aangemaakt, aangemaakt: parseDate(aangemaakt),
      fase: 'Oplospunt', bronStatus: status, omschrijving: omschrijving,
      bedrijf: bedrijf, categorie: '', auteur: auteur, organisatie: organisatie,
      ruimte: ruimte, adres: adres, bouwnummer: bouwnummer
    };
  }).filter(function (r) {
    return OPLOS_ALLOWED_ORGS.indexOf((r.organisatie || '').trim()) !== -1;
  });
  rebuildWorkItems();
}

// Parseer een geconcateneerde uppercase-adrescode uit de S&O-export (zoals
// "KEESVANSPRONSENLAAN36") naar een leesbaar adres ("Kees van Spronsenlaan 36").
// Herkennning gebeurt op basis van bekende Nederlandse straatsuffixen en
// tussenvoegsels. Bij twijfel geven we de ruwe code terug — de gebruiker kan
// hem via de handmatige override in de drawer altijd bijstellen.
var STRAAT_SUFFIX_RE = /^(.+?)(LAAN|STRAAT|WEG|PLEIN|PARK|SINGEL|KADE|HOF|GRACHT|DIJK|WIJK|BAAN|DREEF|ERF|BOULEVARD|PAD|BRINK|BOS|VELD)$/i;
var TUSSENVOEGSEL_RE = /(van|de|der|den|ter|ten|op|aan|in|het|te|voor)([a-z]{2,})/gi;
function parseAdresCode(code) {
  if (!code) return '';
  var s = String(code).trim();
  var m = s.match(/^(.*?)(\d+(?:[-\/\.]\d+)?[A-Za-z]?)$/);
  if (!m || !m[1]) return s;
  var letters = m[1];
  var nummer = m[2];
  var straatBase = letters, straatSuf = '';
  var sufMatch = letters.match(STRAAT_SUFFIX_RE);
  if (sufMatch) { straatBase = sufMatch[1]; straatSuf = sufMatch[2]; }
  var basis = straatBase.charAt(0).toUpperCase() + straatBase.slice(1).toLowerCase();
  basis = basis.replace(TUSSENVOEGSEL_RE, function (all, prep, rest) {
    return ' ' + prep.toLowerCase() + ' ' + rest.charAt(0).toUpperCase() + rest.slice(1);
  });
  return (basis + straatSuf.toLowerCase()).replace(/\s+/g, ' ').trim() + ' ' + nummer;
}

// ── Werkvoorraad samenstellen ───────────────────────────────────────────────
// Open bronitems + items met plandata waarvan de bron inmiddels gesloten is.
function rebuildWorkItems() {
  var map = {};
  var all = sourceItems.so.concat(sourceItems.ol);
  all.forEach(function (it) {
    var open = (it.bronStatus || '').trim().toLowerCase() === 'open';
    var plan = getPlan(it.id);
    if (open) {
      map[it.id] = it;
      if (plan && plan.bronGesloten) { plan.bronGesloten = false; }
    } else if (plan) {
      // Plandata bestaat maar bron is gesloten → markeren, niet weggooien
      if (!plan.bronGesloten && plan.werkstatus !== 'gesloten') {
        plan.bronGesloten = true;
        logHist(plan, 'Bronstatus is inmiddels "' + (it.bronStatus || '?') + '"');
      }
      map[it.id] = it;
    }
  });
  // Verweesde planitems (plandata aanwezig, bronrecord niet meer in export)
  var loadedIds = {};
  all.forEach(function (it) { loadedIds[it.id] = true; });
  var anyLoaded = all.length > 0;
  Object.keys(planstore.items).forEach(function (id) {
    if (map[id]) return;
    var plan = planstore.items[id];
    var snap = plan.snapshot || {};
    // Alleen tonen als de bijbehorende bron wél geladen is maar het item ontbreekt
    var bronLoaded = snap.bron === 'so' ? sourceItems.so.length > 0 : sourceItems.ol.length > 0;
    if (!anyLoaded || !bronLoaded) return;
    if (plan.werkstatus === 'gesloten') return;
    if (!plan.bronGesloten) { plan.bronGesloten = true; logHist(plan, 'Item niet meer aanwezig in bron-export'); }
    map[id] = {
      id: id, bron: snap.bron || 'so', nummer: snap.nummer || '?', hyperlink: snap.hyperlink || '',
      project: snap.project || 'Onbekend', aangemaaktRaw: snap.aangemaakt || '',
      aangemaakt: parseDate(snap.aangemaakt), fase: '', bronStatus: 'Onbekend',
      omschrijving: snap.omschrijving || '', bedrijf: snap.bedrijf || '', categorie: '',
      ruimte: '', adres: '', bouwnummer: ''
    };
  });
  workItems = Object.keys(map).map(function (k) { return map[k]; });
  saveStore();
  populateFilters();
  renderAll();
}

// ── Filters ─────────────────────────────────────────────────────────────────
function toggleDropdown(id) {
  var el = document.getElementById(id);
  var wasOpen = el.classList.contains('open');
  document.querySelectorAll('.ms-wrap.open').forEach(function (w) { w.classList.remove('open'); });
  if (!wasOpen) el.classList.add('open');
}
document.addEventListener('click', function (e) {
  if (!e.target.closest('.ms-wrap')) document.querySelectorAll('.ms-wrap.open').forEach(function (w) { w.classList.remove('open'); });
});

function populateFilters() {
  var bronnen = [{ v: 'so', l: 'S&O meldingen' }, { v: 'ol', l: 'Oplospunten' }];
  fillList('ms-bron', bronnen.map(function (b) { return b.v; }), function (v) { return v === 'so' ? 'S&O meldingen' : 'Oplospunten'; });
  fillList('ms-bedrijf', uniq(workItems.map(function (r) { return r.bedrijf || 'Onbekend'; })));
  fillList('ms-project', uniq(workItems.map(function (r) { return r.project || 'Onbekend'; })));
  fillList('ms-nummer', uniq(workItems.map(function (r) { return effNummer(r) || '?'; })));
  fillList('ms-status', WERKSTATUS.map(function (s) { return s.key; }), function (k) { return stDef(k).label; });
  fillList('ms-behandelaar', ['(niet toegewezen)'].concat(planstore.team));
  fillList('ms-prio', PRIORITEIT.map(function (p) { return p.key; }), function (k) { return prioDef(k).label; });
  vulPlanbordBehandelaarSelect();
}
function uniq(arr) {
  var seen = {}, out = [];
  arr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
  return out.sort(function (a, b) { return a.localeCompare(b, 'nl'); });
}
function fillList(msId, values, labelFn) {
  var list = document.getElementById(msId + '-list');
  if (!list) return;
  list.innerHTML = values.map(function (v) {
    var checked = selections[msId].has(v) ? ' checked' : '';
    var label = labelFn ? labelFn(v) : v;
    return '<label class="ms-item"><input type="checkbox" value="' + escAttr(v) + '"' + checked + ' onchange="onMsChange(\'' + msId + '\', this)"><span>' + escHtml(label) + '</span></label>';
  }).join('');
  updateMsCount(msId);
}
function onMsChange(msId, cb) {
  if (cb.checked) selections[msId].add(cb.value); else selections[msId].delete(cb.value);
  updateMsCount(msId);
  renderAll();
}
function updateMsCount(msId) {
  var n = selections[msId].size;
  var badge = document.querySelector('#' + msId + ' .ms-count');
  if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-block' : 'none'; }
}
function selectAll(msId) {
  document.querySelectorAll('#' + msId + '-list input').forEach(function (cb) { cb.checked = true; selections[msId].add(cb.value); });
  updateMsCount(msId); renderAll();
}
function deselectAll(msId) {
  selections[msId].clear();
  document.querySelectorAll('#' + msId + '-list input').forEach(function (cb) { cb.checked = false; });
  updateMsCount(msId); renderAll();
}
function filterItems(msId, q) {
  q = q.toLowerCase();
  document.querySelectorAll('#' + msId + '-list .ms-item').forEach(function (item) {
    item.style.display = item.textContent.toLowerCase().indexOf(q) !== -1 ? 'flex' : 'none';
  });
}
function resetFilters() {
  Object.keys(selections).forEach(function (k) { selections[k].clear(); updateMsCount(k); });
  document.querySelectorAll('.ms-list input').forEach(function (cb) { cb.checked = false; });
  document.getElementById('search-box').value = '';
  document.getElementById('chk-brongesloten').checked = false;
  renderAll();
}

// opts.alleenAfgerond → alleen gereed/gesloten items (voor de backlog). Het
// werkstatus-filter en de 'in bron gesloten'-verberging gelden daar niet.
function getFiltered(opts) {
  opts = opts || {};
  var q = document.getElementById('search-box').value.trim().toLowerCase();
  var showBronGesloten = document.getElementById('chk-brongesloten').checked;
  return workItems.filter(function (it) {
    var plan = getPlan(it.id);
    var ws = plan ? plan.werkstatus : 'nieuw';
    var prio = plan ? plan.prio : 'normaal';
    var beh = (plan && plan.behandelaar) ? plan.behandelaar : '(niet toegewezen)';
    var bronGesloten = plan ? plan.bronGesloten : false;
    if (opts.alleenAfgerond) {
      if (ws !== 'gereed' && ws !== 'gesloten') return false;
    } else {
      if (bronGesloten && !showBronGesloten) return false;
      if (ws === 'gesloten' && !selections['ms-status'].has('gesloten')) return false;
    }
    if (selections['ms-bron'].size && !selections['ms-bron'].has(it.bron)) return false;
    if (selections['ms-bedrijf'].size && !selections['ms-bedrijf'].has(it.bedrijf || 'Onbekend')) return false;
    if (selections['ms-project'].size && !selections['ms-project'].has(it.project || 'Onbekend')) return false;
    if (selections['ms-nummer'].size && !selections['ms-nummer'].has(effNummer(it) || '?')) return false;
    if (!opts.alleenAfgerond && selections['ms-status'].size && !selections['ms-status'].has(ws)) return false;
    if (selections['ms-behandelaar'].size && !selections['ms-behandelaar'].has(beh)) return false;
    if (selections['ms-prio'].size && !selections['ms-prio'].has(prio)) return false;
    if (q) {
      var blob = (effNummer(it) + ' ' + it.nummer + ' ' + it.project + ' ' + it.omschrijving + ' ' + it.adres + ' ' + (it.bedrijf || '')).toLowerCase();
      if (blob.indexOf(q) === -1) return false;
    }
    return true;
  });
}

// ── Render alles ────────────────────────────────────────────────────────────
function renderAll() {
  var data = getFiltered();
  renderStats();
  renderWerkvoorraad(data);
  vulPlanbordBehandelaarSelect();
  renderKanban(data);
  renderBacklog();
  renderTeLaat(data);
  renderAgenda(data);
  renderRapportage(data);
  renderTeam();
  if (drawerId) renderDrawer(drawerId);
}

function renderStats() {
  if (!workItems.length) {
    ['stat-total','stat-nieuw','stat-lopend','stat-telaat','stat-gereed'].forEach(function (id) { document.getElementById(id).textContent = '—'; });
    return;
  }
  var totaal = 0, nieuw = 0, lopend = 0, gereed = 0, telaat = 0;
  workItems.forEach(function (it) {
    var plan = getPlan(it.id);
    var ws = plan ? plan.werkstatus : 'nieuw';
    if (ws === 'gesloten') return;
    totaal++;
    if (ws === 'nieuw' || ws === 'beoordeeld') nieuw++;
    if (ws === 'gepland' || ws === 'uitvoering' || ws === 'wachten') lopend++;
    if (ws === 'gereed') gereed++;
    if (isTeLaat(it, plan)) telaat++;
  });
  document.getElementById('stat-total').textContent = totaal;
  document.getElementById('stat-nieuw').textContent = nieuw;
  document.getElementById('stat-lopend').textContent = lopend;
  document.getElementById('stat-telaat').textContent = telaat;
  document.getElementById('stat-gereed').textContent = gereed;
  var badge = document.getElementById('tab-telaat-badge');
  if (badge) { badge.textContent = telaat; badge.style.display = telaat ? 'inline-block' : 'none'; }
}

// ── Tab: Werkvoorraad ───────────────────────────────────────────────────────
function setSort(field) {
  if (sortField === field) sortDir = -sortDir; else { sortField = field; sortDir = 1; }
  renderAll();
}
function sortValue(it, plan) {
  switch (sortField) {
    case 'bron': return it.bron;
    case 'nummer': return effNummer(it) || '';
    case 'project': return it.project || '';
    case 'aangemaakt': return it.aangemaakt ? it.aangemaakt.getTime() : 0;
    case 'streef': var sd = streefDatum(it); return sd ? sd.getTime() : 9e15;
    case 'prio': return PRIORITEIT.map(function (p) { return p.key; }).indexOf(plan ? plan.prio : 'normaal');
    case 'werkstatus': return WERKSTATUS.map(function (s) { return s.key; }).indexOf(plan ? plan.werkstatus : 'nieuw');
    case 'behandelaar': return (plan && plan.behandelaar) || 'zzz';
    case 'gepland': return (plan && plan.gepland) || '9999';
    default: return 0;
  }
}
var WV_COLS = 12;
function wvHeadHtml(alleGeselecteerd) {
  return '<thead><tr>'
    + '<th class="wv-check-col"><input type="checkbox" id="wv-check-all"' + (alleGeselecteerd ? ' checked' : '')
    +   ' title="Alle ongebonden items in beeld selecteren" onchange="toggleSelectAll(this.checked)"></th>'
    + '<th class="sortable" onclick="setSort(\'bron\')">Bron / taaknaam</th>'
    + '<th class="sortable" onclick="setSort(\'nummer\')">Nummer</th>'
    + '<th class="sortable" onclick="setSort(\'project\')">Project</th>'
    + '<th>Omschrijving</th>'
    + '<th class="sortable" onclick="setSort(\'aangemaakt\')">Aangemaakt</th>'
    + '<th class="sortable" onclick="setSort(\'streef\')">Streefdatum</th>'
    + '<th class="sortable" onclick="setSort(\'prio\')">Prio</th>'
    + '<th class="sortable" onclick="setSort(\'werkstatus\')">Werkstatus</th>'
    + '<th class="sortable" onclick="setSort(\'behandelaar\')">Behandelaar</th>'
    + '<th class="sortable" onclick="setSort(\'gepland\')">Gepland</th>'
    + '<th>Acties</th>'
    + '</tr></thead>';
}
function wvRowHtml(it, opts) {
  opts = opts || {};
  var plan = getPlan(it.id);
  var now = new Date(); now.setHours(0, 0, 0, 0);
  var ws = plan ? plan.werkstatus : 'nieuw';
  var prio = plan ? plan.prio : 'normaal';
  var beh = plan ? plan.behandelaar : '';
  var gepland = plan ? plan.gepland : '';
  var acties = plan ? plan.acties : [];
  var openActies = acties.filter(function (a) { return !a.gereed; });
  var heeftActieTeLaat = openActies.some(function (a) { return a.deadline && parseDate(a.deadline) < now; });
  var teLaat = isTeLaat(it, plan);
  var sd = streefDatum(it);
  var bronBadge = it.bron === 'so'
    ? '<span class="badge badge-bron-so">S&amp;O</span>'
    : '<span class="badge badge-bron-ol">Oplospunt</span>';
  if (plan && plan.bronGesloten) bronBadge += ' <span class="badge badge-brongesloten">bron dicht</span>';
  var actiePill = openActies.length
    ? '<span class="actie-pill ' + (heeftActieTeLaat ? 'telaat' : 'heeft') + '">' + openActies.length + ' open' + (heeftActieTeLaat ? ' ⚠' : '') + '</span>'
    : (acties.length ? '<span class="actie-pill">✓ ' + acties.length + '</span>' : '<span class="actie-pill">—</span>');
  var streefCell = sd
    ? '<span style="white-space:nowrap' + (teLaat ? ';color:var(--danger);font-weight:700' : '') + '">' + formatDate(sd) + (teLaat ? ' ⚠' : '') + '</span>'
    : '—';
  // Ontkoppel-knop verschijnt alleen op kind-rijen onder een taak
  var unlinkBtn = opts.childOfTaakId
    ? ' <button class="wv-unlink" title="Ontkoppel van taak" onclick="event.stopPropagation();ontkoppelItem(\'' + opts.childOfTaakId + '\',\'' + it.id + '\')">↩</button>'
    : '';
  var classes = [];
  if (teLaat) classes.push('row-telaat');
  if (opts.childOfTaakId) classes.push('wv-child');
  if (opts.verborgenDoorFilter) classes.push('wv-child-hidden');
  var dataAttr = ' data-item-id="' + it.id + '"'
    + (opts.childOfTaakId ? ' data-parent-taak="' + opts.childOfTaakId + '"' : '');
  // Eerste cel toont een subtiele boom-indicator voor kinderen
  var bronCell = opts.childOfTaakId
    ? '<td><span class="wv-child-marker">↳</span> ' + bronBadge + '</td>'
    : '<td>' + bronBadge + '</td>';
  // Selectievakje voor de bulkacties (toewijzen, projectcode, koppelen aan taak)
  var geselecteerd = wvSelected.has(it.id);
  if (geselecteerd) classes.push('wv-row-selected');
  var checkCell = '<td class="wv-check-col" onclick="event.stopPropagation()">'
    + '<input type="checkbox"' + (geselecteerd ? ' checked' : '')
    + ' onchange="toggleSelectItem(\'' + it.id + '\', this)"></td>';
  // Adres + bouwnummer als subregel onder het project (indien beschikbaar)
  var projectSub = [];
  if (it.adres) projectSub.push(escHtml(it.adres));
  if (it.bouwnummer) projectSub.push('bnr ' + escHtml(it.bouwnummer));
  var projectCell = '<td class="cell-clip narrow" title="' + escAttr(it.project + (projectSub.length ? ' — ' + projectSub.join(' · ') : '')) + '">'
    + '<div class="wv-project-main">' + escHtml(it.project) + '</div>'
    + (projectSub.length ? '<div class="wv-project-sub">' + projectSub.join(' · ') + '</div>' : '')
    + '</td>';
  var classAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
  return '<tr' + classAttr + dataAttr + ' onclick="openDrawer(\'' + it.id + '\')">'
    + checkCell
    + bronCell
    + '<td style="white-space:nowrap;font-weight:600">' + escHtml(effNummer(it)) + '</td>'
    + projectCell
    + '<td class="cell-clip" title="' + escAttr(it.omschrijving) + '">' + escHtml(it.omschrijving) + '</td>'
    + '<td style="white-space:nowrap">' + formatDate(it.aangemaakt) + '</td>'
    + '<td>' + streefCell + '</td>'
    + '<td onclick="event.stopPropagation()">' + prioSelect(it.id, prio) + '</td>'
    + '<td onclick="event.stopPropagation()">' + statusSelect(it.id, ws) + '</td>'
    + '<td onclick="event.stopPropagation()">' + behandelaarSelect(it.id, beh) + '</td>'
    + '<td onclick="event.stopPropagation()"><input type="date" value="' + escAttr(gepland) + '" onchange="setPlanField(\'' + it.id + '\',\'gepland\',this.value)"></td>'
    + '<td>' + actiePill + unlinkBtn + '</td>'
    + '</tr>';
}
function sortData(data) {
  return data.slice().sort(function (a, b) {
    var va = sortValue(a, getPlan(a.id)), vb = sortValue(b, getPlan(b.id));
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    return 0;
  });
}

// Taak weergegeven als bovenliggende rij in de werkvoorraad-tabel. De cellen
// volgen dezelfde 11-kolomsindeling zodat de layout consistent blijft.
function wvTaakRowHtml(taak, zichtbareKinderIds) {
  var prio = prioDef(taak.prio);
  var st = stDef(taak.status);
  var open = takenOpen.has(taak.id);
  var totaal = taak.kinderen.length;
  var zichtbaar = zichtbareKinderIds.length;
  var kinderenBadge = '<span class="wv-taak-count" title="Gekoppelde items (zichtbaar / totaal)">🔗 ' + zichtbaar + (zichtbaar !== totaal ? ' / ' + totaal : '') + '</span>';
  // Aangemaaktdatum kort tonen
  var aangemaaktKort = (taak.aangemaakt || '').split(' ')[0] || '—';
  // Deadline evalueren voor "te laat"-styling
  var deadline = taak.deadline ? parseDate(taak.deadline) : null;
  var now = new Date(); now.setHours(0, 0, 0, 0);
  var deadlineTeLaat = deadline && deadline < now && taak.status !== 'gereed' && taak.status !== 'gesloten';
  var deadlineCell = '<input type="date" value="' + escAttr(taak.deadline || '') + '"'
    + (deadlineTeLaat ? ' style="color:var(--danger);font-weight:700;border-color:var(--danger)"' : '')
    + ' onchange="setTaakField(\'' + taak.id + '\',\'deadline\',this.value)">';
  var classes = ['wv-taak-row'];
  if (deadlineTeLaat) classes.push('row-telaat');
  var kinderenSel = taak.kinderen.length && taak.kinderen.every(function (k) { return wvSelected.has(k); });
  return '<tr class="' + classes.join(' ') + '" data-taak-id="' + taak.id + '" onclick="openDrawer(\'' + taak.id + '\')">'
    + '<td class="wv-check-col" onclick="event.stopPropagation()">'
    +   '<input type="checkbox" title="Alle gekoppelde items van deze taak selecteren"'
    +   (kinderenSel ? ' checked' : '') + (taak.kinderen.length ? '' : ' disabled')
    +   ' onchange="toggleSelectTaak(\'' + taak.id + '\', this.checked)"></td>'
    + '<td class="wv-taak-first" onclick="event.stopPropagation()">'
    +   '<span class="wv-taak-toggle" title="Uitklappen / inklappen" onclick="toggleTaakOpen(\'' + taak.id + '\')">' + (open ? '▼' : '▶') + '</span>'
    +   '<span class="badge badge-taak">📋</span>'
    +   '<input class="wv-taak-titel" type="text" value="' + escAttr(taak.titel) + '"'
    +   ' placeholder="Naam van de taak…" title="' + escHtml(taak.titel || 'Naam van de taak') + '"'
    +   ' onchange="setTaakField(\'' + taak.id + '\',\'titel\',this.value)">'
    + '</td>'
    + '<td onclick="event.stopPropagation()">'
    +   '<input class="wv-taak-nummer" type="text" value="' + escAttr(taak.projectnummer || '') + '"'
    +   ' placeholder="Projectnummer…"'
    +   ' title="Interne projectcode — wordt overgenomen als nummer op alle gekoppelde meldingen en oplospunten"'
    +   ' onchange="setTaakField(\'' + taak.id + '\',\'projectnummer\',this.value)">'
    + '</td>'
    + '<td>' + kinderenBadge + '</td>'
    + '<td class="cell-clip" title="' + escAttr(taak.omschrijving) + '">' + escHtml(taak.omschrijving || '—') + '</td>'
    + '<td style="white-space:nowrap">' + escHtml(aangemaaktKort) + '</td>'
    + '<td onclick="event.stopPropagation()" class="' + (deadlineTeLaat ? 'wv-taak-deadline-late' : '') + '">' + deadlineCell + '</td>'
    + '<td onclick="event.stopPropagation()">' + taakPrioSelect(taak.id, taak.prio) + '</td>'
    + '<td onclick="event.stopPropagation()">' + taakStatusSelect(taak.id, taak.status) + '</td>'
    + '<td onclick="event.stopPropagation()">' + taakBehandelaarSelect(taak.id, taak.behandelaar) + '</td>'
    + '<td class="cell-clip narrow">—</td>'
    + '<td onclick="event.stopPropagation()"><button class="wv-taak-del" title="Taak verwijderen" onclick="verwijderTaak(\'' + taak.id + '\')">🗑</button></td>'
    + '</tr>';
}

// Uitklaprij: verschijnt onder een uitgeklapte taak en bevat de koppel-dropdown
// en een editor voor de taak-omschrijving.
function wvTaakDetailRowHtml(taak) {
  return '<tr class="wv-taak-detail-row" data-taak-id="' + taak.id + '">'
    + '<td colspan="' + WV_COLS + '">'
    +   '<div class="wv-taak-detail">'
    +     '<div class="wv-taak-detail-block">'
    +       '<label>Omschrijving</label>'
    +       '<textarea rows="2" placeholder="Omschrijving / doel van de taak…"'
    +       ' onchange="setTaakField(\'' + taak.id + '\',\'omschrijving\',this.value)">' + escHtml(taak.omschrijving) + '</textarea>'
    +     '</div>'
    +     '<div class="wv-taak-detail-block">'
    +       '<label>Koppel een melding of oplospunt</label>'
    +       '<div class="wv-taak-koppel-form">' + taakKoppelSelectHtml(taak.id) + '</div>'
    +     '</div>'
    +     '<div class="wv-taak-detail-block breed">'
    +       '<label>Oorzaak / kostensoort — geldt voor alle gekoppelde meldingen</label>'
    +       taakOorzaakFormHtml(taak, 'wv')
    +       '<div class="oorzaak-chips">' + taakOorzaakChipsHtml(taak) + '</div>'
    +     '</div>'
    +   '</div>'
    + '</td>'
    + '</tr>';
}

// Toetst of een taak zichtbaar moet blijven bij de actieve filters.
// - Eigen velden (status, prio, behandelaar): moeten in de selectie zitten (of selectie leeg = alles)
// - Bron/bedrijf/project: alleen relevant bij taken MET kinderen — dan moet er
//   minstens één kind in de gefilterde set zitten. Losse taken (0 kinderen)
//   worden hierdoor niet gehinderd (want ze hebben geen bron/project/bedrijf).
// - Zoekbalk: taak match als titel/omschrijving/kind-tekst de zoekterm bevat.
// - Gesloten taken worden standaard verborgen, tenzij 'gesloten' expliciet in
//   de status-filter zit.
function taakMatchesFilters(taak, zichtbaarSet, q, toonGesloten) {
  if (!toonGesloten && taak.status === 'gesloten' && !selections['ms-status'].has('gesloten')) return false;
  if (selections['ms-status'].size && !selections['ms-status'].has(taak.status)) return false;
  if (selections['ms-prio'].size && !selections['ms-prio'].has(taak.prio)) return false;
  var beh = taak.behandelaar || '(niet toegewezen)';
  if (selections['ms-behandelaar'].size && !selections['ms-behandelaar'].has(beh)) return false;
  var heeftKinderen = taak.kinderen.length > 0;
  var bronprojfilterActief = selections['ms-bron'].size || selections['ms-bedrijf'].size || selections['ms-project'].size || selections['ms-nummer'].size;
  if (bronprojfilterActief) {
    // Zonder kinderen heeft een taak geen bron/bedrijf/project-relatie, dus valt
    // hij buiten scope zodra een van die filters actief is.
    if (!heeftKinderen) return false;
    var zichtbaarKind = taak.kinderen.some(function (kid) { return zichtbaarSet[kid]; });
    if (!zichtbaarKind) return false;
  }
  if (q) {
    var blob = ((taak.titel || '') + ' ' + (taak.omschrijving || '')).toLowerCase();
    if (blob.indexOf(q) === -1) {
      // Fallback: zoekterm komt uit een van de kinderen — die zit dan al in zichtbaarSet.
      var kindMatch = heeftKinderen && taak.kinderen.some(function (kid) { return zichtbaarSet[kid]; });
      if (!kindMatch) return false;
    }
  }
  return true;
}

function renderWerkvoorraad(data) {
  var container = document.getElementById('wv-container');
  // Selectie opschonen: ID's die niet meer in de werkvoorraad zitten
  Array.from(wvSelected).forEach(function (id) { if (!findItem(id)) wvSelected.delete(id); });
  if (!workItems.length && !planstore.taken.length) {
    document.getElementById('wv-count').textContent = '';
    container.innerHTML = '<div class="empty-state">Laad eerst de twee bron-JSON\'s via de knoppen bovenin — of maak alvast een generieke taak aan met <strong>+ Nieuwe taak</strong>.</div>';
    renderBulkBar();
    return;
  }
  var sorted = sortData(data);
  // Set van zichtbare (gefilterde) item-ID's
  var zichtbaarSet = {};
  sorted.forEach(function (it) { zichtbaarSet[it.id] = true; });
  // Bouw parent-map: itemId → taakId
  var parentMap = {};
  planstore.taken.forEach(function (t) {
    t.kinderen.forEach(function (kid) { parentMap[kid] = t.id; });
  });
  // Splits: kinderen (in een taak) vs. ongebonden. Zodra een melding of oplospunt
  // aan een taak hangt, verdwijnt hij hier en staat hij nog uitsluitend onder die taak.
  var ongebonden = sorted.filter(function (it) { return !parentMap[it.id]; });

  // Taken-blok: taken respecteren de filters. Losse taken (0 kinderen) matchen
  // alleen op hun eigen velden (status, prio, behandelaar, search) — bron/bedrijf/
  // project gelden voor hen niet.
  var q = (document.getElementById('search-box').value || '').trim().toLowerCase();
  var takenLijst = planstore.taken.filter(function (taak) {
    // Afgeronde taken verhuizen naar de Backlog-tab, tenzij je die status
    // expliciet in het werkstatus-filter aanvinkt.
    if (isAfgerond(taak) && !selections['ms-status'].has(taak.status)) return false;
    return taakMatchesFilters(taak, zichtbaarSet, q);
  });
  var takenHtml = '';
  takenLijst.forEach(function (taak) {
    var zichtbareKids = taak.kinderen.filter(function (kid) { return zichtbaarSet[kid]; });
    takenHtml += wvTaakRowHtml(taak, zichtbareKids);
    if (takenOpen.has(taak.id)) {
      takenHtml += wvTaakDetailRowHtml(taak);
      // Alle kinderen tonen wanneer uitgeklapt (ook items die door filter zijn weggevallen),
      // met een discreet 'verborgen door filter'-markering.
      taak.kinderen.forEach(function (kid) {
        var it = findItem(kid);
        if (!it) {
          takenHtml += '<tr class="wv-child wv-child-missing"><td colspan="' + WV_COLS + '">'
            + '<span class="wv-child-marker">↳</span> ⚠ Item niet geladen (' + escHtml(kid) + ') '
            + '<button class="wv-unlink" onclick="event.stopPropagation();ontkoppelItem(\'' + taak.id + '\',\'' + kid + '\')">↩ Ontkoppel</button>'
            + '</td></tr>';
          return;
        }
        takenHtml += wvRowHtml(it, { childOfTaakId: taak.id, verborgenDoorFilter: !zichtbaarSet[kid] });
      });
    }
  });

  // Ongebonden meldingen & oplospunten — altijd gegroepeerd per project (families).
  // Elke projectkop is uitklapbaar; bij een actieve zoekopdracht klappen we alles
  // open zodat treffers niet in een dichtgeklapte familie verdwijnen.
  var groups = groupItemsByProject(ongebonden);
  var zoekActief = !!q;
  var losseHtml = groups.map(function (g) {
    var open = zoekActief || openProjecten.has(g.name);
    var html = wvProjectHeaderHtml(g, open);
    if (open) html += g.items.map(function (it) { return wvRowHtml(it); }).join('');
    return html;
  }).join('');

  // Scheidingsrij tussen taken en ongebonden items
  var separator = ongebonden.length
    ? '<tr class="wv-separator-row"><td colspan="' + WV_COLS + '">Ongebonden meldingen &amp; oplospunten — '
      + groups.length + ' project' + (groups.length !== 1 ? 'en' : '') + ' · ' + ongebonden.length + ' item' + (ongebonden.length !== 1 ? 's' : '')
      + (zoekActief ? ' <span class="wv-separator-hint">(alles uitgeklapt vanwege de zoekopdracht)</span>' : '')
      + '</td></tr>'
    : '';

  document.getElementById('wv-count').textContent = takenLijst.length + '/' + planstore.taken.length + ' taken · '
    + data.length + ' items (' + ongebonden.length + ' ongebonden in ' + groups.length + ' project' + (groups.length !== 1 ? 'en' : '') + ')';
  if (!takenHtml && !losseHtml) {
    container.innerHTML = '<div class="empty-state">Geen items binnen de huidige filters. Maak eventueel een <strong>+ Nieuwe taak</strong> aan.</div>';
    renderBulkBar();
    return;
  }
  var alleGeselecteerd = ongebonden.length > 0 && ongebonden.every(function (it) { return wvSelected.has(it.id); });
  container.innerHTML = '<table class="data-table">' + wvHeadHtml(alleGeselecteerd) + '<tbody>' + takenHtml + separator + losseHtml + '</tbody></table>';
  syncSelectieUI();
}

// Projectkop (familie) boven de meldingen en oplospunten van dat project.
function wvProjectHeaderHtml(g, open) {
  var lateN = g.items.filter(function (it) { return isTeLaat(it, getPlan(it.id)); }).length;
  var soN = g.items.filter(function (it) { return it.bron === 'so'; }).length;
  var olN = g.items.length - soN;
  var alleSel = g.items.length > 0 && g.items.every(function (it) { return wvSelected.has(it.id); });
  return '<tr class="wv-project-row' + (open ? ' open' : '') + '" data-project="' + escHtml(g.name) + '">'
    + '<td class="wv-check-col" onclick="event.stopPropagation()">'
    +   '<input type="checkbox"' + (alleSel ? ' checked' : '') + ' title="Alle items van dit project selecteren"'
    +   ' onchange="toggleSelectProject(\'' + escAttr(g.name) + '\', this.checked)"></td>'
    + '<td colspan="' + (WV_COLS - 1) + '" onclick="toggleProjectOpen(\'' + escAttr(g.name) + '\')">'
    +   '<span class="wv-proj-toggle">' + (open ? '▼' : '▶') + '</span>'
    +   '<span class="wv-proj-naam">' + escHtml(g.name) + '</span>'
    +   '<span class="wv-proj-tellers">'
    +     (soN ? '<span class="badge badge-bron-so">' + soN + ' S&amp;O</span>' : '')
    +     (olN ? '<span class="badge badge-bron-ol">' + olN + ' oplospunt' + (olN !== 1 ? 'en' : '') + '</span>' : '')
    +   '</span>'
    +   '<span class="grp-count">' + g.items.length + ' item' + (g.items.length !== 1 ? 's' : '') + '</span>'
    +   (lateN ? '<span class="grp-late">' + lateN + ' te laat</span>' : '')
    + '</td></tr>';
}

// ── Uitklappen van projectfamilies ──────────────────────────────────────────
function toggleProjectOpen(naam) {
  if (openProjecten.has(naam)) openProjecten.delete(naam); else openProjecten.add(naam);
  renderWerkvoorraad(getFiltered());
}
function setAlleProjectenOpen(open) {
  openProjecten.clear();
  if (open) {
    var parentMap = {};
    planstore.taken.forEach(function (t) { t.kinderen.forEach(function (kid) { parentMap[kid] = 1; }); });
    getFiltered().forEach(function (it) { if (!parentMap[it.id]) openProjecten.add(it.project || 'Onbekend project'); });
  }
  renderWerkvoorraad(getFiltered());
}

// ── Selectie & bulkacties ───────────────────────────────────────────────────
// Alle items die nu in het ongebonden blok staan (na filtering).
function ongebondenItems() {
  var parentMap = {};
  planstore.taken.forEach(function (t) { t.kinderen.forEach(function (kid) { parentMap[kid] = 1; }); });
  return getFiltered().filter(function (it) { return !parentMap[it.id]; });
}
function selectieItems() {
  var out = [];
  wvSelected.forEach(function (id) { var it = findItem(id); if (it) out.push(it); });
  return out;
}
// Aan-/uitvinken van één rij: geen volledige rerender, anders springt de tabel
// bij elk vinkje terug naar boven.
function toggleSelectItem(id, cb) {
  if (cb.checked) wvSelected.add(id); else wvSelected.delete(id);
  syncSelectieUI();
}
function toggleSelectProject(naam, on) {
  ongebondenItems().forEach(function (it) {
    if ((it.project || 'Onbekend project') !== naam) return;
    if (on) wvSelected.add(it.id); else wvSelected.delete(it.id);
  });
  syncSelectieUI();
}
function toggleSelectTaak(taakId, on) {
  var t = findTaak(taakId);
  if (!t) return;
  t.kinderen.forEach(function (kid) { if (on) wvSelected.add(kid); else wvSelected.delete(kid); });
  syncSelectieUI();
}
function toggleSelectAll(on) {
  ongebondenItems().forEach(function (it) { if (on) wvSelected.add(it.id); else wvSelected.delete(it.id); });
  syncSelectieUI();
}
function wisSelectie() {
  wvSelected.clear();
  syncSelectieUI();
}
// Zet de vinkjes en rij-markeringen gelijk aan de selectie-state, zonder rerender.
function syncSelectieUI() {
  var container = document.getElementById('wv-container');
  if (container) {
    container.querySelectorAll('tr[data-item-id]').forEach(function (tr) {
      var sel = wvSelected.has(tr.getAttribute('data-item-id'));
      var cb = tr.querySelector('.wv-check-col input');
      if (cb) cb.checked = sel;
      tr.classList.toggle('wv-row-selected', sel);
    });
    var ong = ongebondenItems();
    var perProject = {};
    ong.forEach(function (it) {
      var naam = it.project || 'Onbekend project';
      if (!perProject[naam]) perProject[naam] = [];
      perProject[naam].push(it);
    });
    container.querySelectorAll('tr.wv-project-row').forEach(function (tr) {
      var items = perProject[tr.getAttribute('data-project')] || [];
      var cb = tr.querySelector('.wv-check-col input');
      if (!cb) return;
      cb.checked = items.length > 0 && items.every(function (it) { return wvSelected.has(it.id); });
      cb.indeterminate = !cb.checked && items.some(function (it) { return wvSelected.has(it.id); });
    });
    container.querySelectorAll('tr[data-taak-id] .wv-check-col input').forEach(function (cb) {
      var t = findTaak(cb.closest('tr').getAttribute('data-taak-id'));
      if (!t) return;
      cb.checked = t.kinderen.length > 0 && t.kinderen.every(function (k) { return wvSelected.has(k); });
      cb.indeterminate = !cb.checked && t.kinderen.some(function (k) { return wvSelected.has(k); });
    });
    var master = document.getElementById('wv-check-all');
    if (master) {
      var alle = ong.length > 0 && ong.every(function (it) { return wvSelected.has(it.id); });
      master.checked = alle;
      master.indeterminate = !alle && ong.some(function (it) { return wvSelected.has(it.id); });
    }
  }
  renderBulkBar();
}

// Balk met bulkacties; verschijnt zodra er iets is aangevinkt.
function renderBulkBar() {
  var bar = document.getElementById('wv-bulkbar');
  if (!bar) return;
  var n = wvSelected.size;
  if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '<span class="bulk-count">' + n + ' geselecteerd</span>'
    + '<div class="bulk-group"><label>Toewijzen aan</label>'
    +   '<select onchange="bulkBehDraft=this.value">' + bulkBehandelaarOpties() + '</select>'
    +   '<button class="btn-primary" onclick="bulkZetBehandelaar()">Toewijzen</button></div>'
    + '<div class="bulk-group"><label>Interne projectcode</label>'
    +   '<input type="text" value="' + escHtml(bulkCodeDraft) + '" placeholder="bv. 24-0123"'
    +   ' oninput="bulkCodeDraft=this.value" onkeydown="if(event.key===\'Enter\')bulkZetProjectcode()">'
    +   '<button class="btn-primary" onclick="bulkZetProjectcode()">Toepassen</button></div>'
    + '<div class="bulk-group"><label>Koppelen aan taak</label>'
    +   '<select onchange="bulkTaakDraft=this.value">' + bulkTaakOpties() + '</select>'
    +   '<button class="btn-primary" onclick="bulkKoppelAanTaak()">Koppelen</button></div>'
    + '<button class="bulk-clear" onclick="wisSelectie()">✕ Selectie wissen</button>';
}
function bulkBehandelaarOpties() {
  var opts = ['<option value="">— kies behandelaar —</option>',
              '<option value="__leeg__"' + (bulkBehDraft === '__leeg__' ? ' selected' : '') + '>— toewijzing wissen —</option>'];
  planstore.team.forEach(function (t) {
    opts.push('<option value="' + escAttr(t) + '"' + (t === bulkBehDraft ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
  if (!planstore.team.length) opts.push('<option value="" disabled>Voeg eerst behandelaars toe bij Team &amp; instellingen</option>');
  return opts.join('');
}
function bulkTaakOpties() {
  var opts = ['<option value="">— kies taak —</option>',
              '<option value="__new__"' + (bulkTaakDraft === '__new__' ? ' selected' : '') + '>+ Nieuwe taak van deze selectie</option>'];
  planstore.taken.forEach(function (t) {
    var label = taakLabel(t) + (t.kinderen.length ? ' — ' + t.kinderen.length + ' items' : '');
    opts.push('<option value="' + escAttr(t.id) + '"' + (t.id === bulkTaakDraft ? ' selected' : '') + '>' + escHtml(label) + '</option>');
  });
  return opts.join('');
}
function bulkZetBehandelaar() {
  var items = selectieItems();
  if (!items.length) return;
  if (!bulkBehDraft) { alert('Kies eerst een behandelaar.'); return; }
  var naam = bulkBehDraft === '__leeg__' ? '' : bulkBehDraft;
  if (!confirm(items.length + ' item(s) toewijzen aan ' + (naam || '— niemand —') + '?')) return;
  var n = 0;
  items.forEach(function (it) { if (applyPlanField(it.id, 'behandelaar', naam)) n++; });
  saveStore();
  renderAll();
  toastMelding(n + ' van ' + items.length + ' item(s) toegewezen aan ' + (naam || 'niemand'));
}
function bulkZetProjectcode() {
  var items = selectieItems();
  if (!items.length) return;
  var code = (bulkCodeDraft || '').trim();
  var metCode = items.filter(function (it) {
    var pl = getPlan(it.id);
    return pl && pl.bron && pl.bron.projectcodeIntern;
  }).length;
  var msg = code
    ? 'Interne projectcode van ' + items.length + ' item(s) zetten op "' + code + '"?'
    : 'Interne projectcode van ' + items.length + ' item(s) wissen? Het Bhome-nummer wordt dan weer getoond.';
  if (metCode) msg += '\n\nLet op: ' + metCode + ' item(s) hebben al een code — die wordt overschreven.';
  if (!confirm(msg)) return;
  var n = 0;
  items.forEach(function (it) { if (applyBronField(it.id, 'projectcodeIntern', code)) n++; });
  saveStore();
  populateFilters();
  renderAll();
  toastMelding(n + ' van ' + items.length + ' item(s) ' + (code ? 'op nummer "' + code + '" gezet' : 'teruggezet op het Bhome-nummer'));
}
function bulkKoppelAanTaak() {
  var items = selectieItems();
  if (!items.length) return;
  if (!bulkTaakDraft) { alert('Kies eerst een taak, of "+ Nieuwe taak van deze selectie".'); return; }
  var taak;
  if (bulkTaakDraft === '__new__') {
    var projecten = {};
    items.forEach(function (it) { projecten[it.project || 'Onbekend project'] = 1; });
    var namen = Object.keys(projecten);
    var suggestie = namen.length === 1 ? ('Werkpakket ' + namen[0]) : ('Werkpakket ' + items.length + ' items');
    var titel = prompt('Titel van de nieuwe taak:', suggestie);
    if (titel === null) return;
    taak = maakTaak(titel.trim(), 'Taak aangemaakt vanuit selectie (' + items.length + ' items)');
  } else {
    taak = findTaak(bulkTaakDraft);
    if (!taak) return;
    if (!confirm(items.length + ' item(s) koppelen aan taak "' + taakLabel(taak) + '"?\n\nZe verdwijnen uit het ongebonden blok en komen op het planbord onder deze taak.')) return;
  }
  items.forEach(function (it) { applyKoppelItemAanTaak(taak.id, it.id); });
  takenOpen.add(taak.id);
  wvSelected.clear();
  bulkTaakDraft = '';
  saveStore();
  renderAll();
  toastMelding(items.length + ' item(s) gekoppeld aan "' + taakLabel(taak) + '"');
}
// Korte bevestiging rechtsonder in beeld.
function toastMelding(tekst) {
  var el = document.getElementById('bulk-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bulk-toast';
    el.className = 'bulk-toast';
    document.body.appendChild(el);
  }
  el.textContent = tekst;
  el.classList.add('zichtbaar');
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.classList.remove('zichtbaar'); }, 3500);
}

// Groepeer items per project, gesorteerd op meeste te-laat, dan aantal.
function groupItemsByProject(items) {
  var map = {};
  items.forEach(function (it) {
    var p = it.project || 'Onbekend project';
    if (!map[p]) map[p] = { name: p, items: [] };
    map[p].items.push(it);
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
    var la = a.items.filter(function (it) { return isTeLaat(it, getPlan(it.id)); }).length;
    var lb = b.items.filter(function (it) { return isTeLaat(it, getPlan(it.id)); }).length;
    if (lb !== la) return lb - la;
    return b.items.length - a.items.length;
  });
}
function statusSelect(id, current) {
  var d = stDef(current);
  return '<select style="color:' + d.hex + ';font-weight:600" onchange="setPlanField(\'' + id + '\',\'werkstatus\',this.value)">'
    + WERKSTATUS.map(function (s) { return '<option value="' + s.key + '"' + (s.key === current ? ' selected' : '') + '>' + s.label + '</option>'; }).join('')
    + '</select>';
}
function prioSelect(id, current) {
  var d = prioDef(current);
  return '<select style="color:' + d.hex + ';font-weight:700" onchange="setPlanField(\'' + id + '\',\'prio\',this.value)">'
    + PRIORITEIT.map(function (p) { return '<option value="' + p.key + '"' + (p.key === current ? ' selected' : '') + '>' + p.label + '</option>'; }).join('')
    + '</select>';
}
function behandelaarSelect(id, current) {
  var opts = ['<option value=""' + (!current ? ' selected' : '') + '>—</option>'];
  planstore.team.forEach(function (t) {
    opts.push('<option value="' + escAttr(t) + '"' + (t === current ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
  if (current && planstore.team.indexOf(current) === -1) {
    opts.push('<option value="' + escAttr(current) + '" selected>' + escHtml(current) + '</option>');
  }
  return '<select onchange="setPlanField(\'' + id + '\',\'behandelaar\',this.value)">' + opts.join('') + '</select>';
}

// ── Mutaties op plandata ────────────────────────────────────────────────────
var FIELD_LABELS = { werkstatus: 'Werkstatus', prio: 'Prioriteit', behandelaar: 'Behandelaar', gepland: 'Geplande datum', uren: 'Geschatte uren', oorzaak: 'Oorzaak', oplossing: 'Oplossing' };
// Muteert alleen de plandata (geen opslag/rerender) — zo kan een bulkactie
// honderden items wijzigen en pas daarna één keer opslaan en hertekenen.
function applyPlanField(id, field, value) {
  var it = findItem(id);
  if (!it) return false;
  var plan = ensurePlan(it);
  var oud = plan[field];
  if (oud === value) return false;
  if (field === 'werkstatus') zetWerkstatus(plan, value); else plan[field] = value;
  var label = FIELD_LABELS[field] || field;
  var display = value;
  if (field === 'werkstatus') display = stDef(value).label;
  if (field === 'prio') display = prioDef(value).label;
  if (field === 'gepland') display = formatISO(value);
  if (field === 'oorzaak') display = oorzaakLabel(value);
  logHist(plan, label + ' → ' + (display || 'leeg'));
  // Automatisch status meebewegen bij plannen
  if (field === 'gepland' && value && (plan.werkstatus === 'nieuw' || plan.werkstatus === 'beoordeeld')) zetWerkstatus(plan, 'gepland');
  if (field === 'behandelaar' && value && plan.werkstatus === 'nieuw') zetWerkstatus(plan, 'beoordeeld');
  // Geef je een melding een andere oorzaak, dan verschijnt die oorzaak ook in
  // het rijtje van de taak — zo zie je daar alle oorzaken die op dit project spelen.
  if (field === 'oorzaak' && value) {
    var ouder = taakVoorItem(id);
    if (ouder) {
      if (!Array.isArray(ouder.oorzaken)) ouder.oorzaken = [];
      if (ouder.oorzaken.indexOf(value) === -1) {
        ouder.oorzaken.push(value);
        logTaakHist(ouder, 'Oorzaak erbij vanuit een melding: ' + oorzaakLabel(value));
      }
    }
  }
  return true;
}
function setPlanField(id, field, value) {
  if (!applyPlanField(id, field, value)) return;
  saveStore();
  renderAll();
}

// Handmatige overrides / aanvullingen op broninformatie (bv. plaats, tel.nr, interne projectcode).
// Leeg (of gelijk aan bronwaarde) → override verwijderen zodat bron weer doorwerkt.
var BRON_LABELS = { projectcodeIntern: 'Interne projectcode', klacht: 'Klacht', bnr: 'BNR (bouwnummer)', plaats: 'Plaats', adres: 'Adres', telnr: 'Tel.nr', bwc: 'BWC contact' };
function applyBronField(id, field, value) {
  var it = findItem(id);
  if (!it) return false;
  var plan = ensurePlan(it);
  if (!plan.bron) plan.bron = {};
  var v = String(value == null ? '' : value).trim();
  var oud = plan.bron[field] || '';
  if (oud === v) return false;
  if (v === '') delete plan.bron[field];
  else plan.bron[field] = v;
  logHist(plan, (BRON_LABELS[field] || field) + ' → ' + (v || 'leeg'));
  return true;
}
function setBronField(id, field, value) {
  if (!applyBronField(id, field, value)) return;
  saveStore();
  // Volledige rerender zodat de aangepaste code (o.a. interne projectcode)
  // direct terug te zien is in de werkvoorraadtabel, planbord, kaart, zoekindex
  // en de nummer-filter. Werkt omdat inputs 'onchange' gebruiken — focus is al
  // afgestaan tegen de tijd dat we hier komen.
  populateFilters();
  renderAll();
}
// Toont handmatige waarde als die is ingevuld, anders de bronwaarde.
function bronEffectief(plan, field, sourceValue) {
  if (plan && plan.bron && plan.bron[field]) return plan.bron[field];
  return sourceValue || '';
}
// Effectief nummer = interne projectcode (indien gezet) → anders het Bhome-nummer.
// Wordt overal in de UI gebruikt (werkvoorraad, kanban, kaart, te laat, taken)
// zodat de handmatige projectcode consistent doorwerkt in het hele dashboard.
function effNummer(it) {
  if (!it) return '';
  var plan = getPlan(it.id);
  return bronEffectief(plan, 'projectcodeIntern', it.nummer);
}
function findItem(id) {
  for (var i = 0; i < workItems.length; i++) if (workItems[i].id === id) return workItems[i];
  return null;
}

// ── Tab: Planbord (kanban) ──────────────────────────────────────────────────
// Het planbord toont TAKEN, niet losse meldingen. Een melding of oplospunt komt
// hier pas terug zodra hij aan een taak is gekoppeld; de taak is de eenheid die
// je plant en versleept, de gekoppelde items staan als regels op de kaart.
var KB_MAX_CARDS = 40;      // taken per kolom
var KB_MAX_KINDEREN = 6;    // getoonde items per taakkaart

// Project van een taak = het project van de gekoppelde items.
function taakProjectNaam(t) {
  var namen = {};
  t.kinderen.forEach(function (kid) {
    var it = findItem(kid);
    if (it) namen[it.project || 'Onbekend project'] = 1;
  });
  var keys = Object.keys(namen);
  if (!keys.length) return 'Zonder gekoppelde items';
  if (keys.length === 1) return keys[0];
  return keys.length + ' projecten';
}
// Wie pakt het op: de behandelaar van de taak plus die van de gekoppelde items.
function taakBehandelaars(t) {
  var set = {};
  if (t.behandelaar) set[t.behandelaar] = 1;
  t.kinderen.forEach(function (kid) {
    var plan = getPlan(kid);
    if (plan && plan.behandelaar) set[plan.behandelaar] = 1;
  });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'nl'); });
}
function taakMatchesBehandelaar(t) {
  if (!planbordBehandelaar) return true;
  var lijst = taakBehandelaars(t);
  if (planbordBehandelaar === '(niet toegewezen)') return lijst.length === 0;
  return lijst.indexOf(planbordBehandelaar) !== -1;
}
function setPlanbordBehandelaar(v) {
  planbordBehandelaar = v;
  renderKanban(getFiltered());
}
function vulPlanbordBehandelaarSelect() {
  var sel = document.getElementById('pb-behandelaar');
  if (!sel) return;
  var namen = planstore.team.slice();
  planstore.taken.forEach(function (t) {
    taakBehandelaars(t).forEach(function (n) { if (namen.indexOf(n) === -1) namen.push(n); });
  });
  var opts = ['<option value="">Iedereen</option>', '<option value="(niet toegewezen)">(niet toegewezen)</option>'];
  namen.sort(function (a, b) { return a.localeCompare(b, 'nl'); }).forEach(function (n) {
    opts.push('<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>');
  });
  sel.innerHTML = opts.join('');
  sel.value = planbordBehandelaar;
  if (sel.value !== planbordBehandelaar) planbordBehandelaar = sel.value;
}

function kbTaakCardHtml(t, zichtbaarSet) {
  var prio = prioDef(t.prio);
  var now = new Date(); now.setHours(0, 0, 0, 0);
  var deadline = t.deadline ? parseDate(t.deadline) : null;
  var deadlineTeLaat = deadline && deadline < now && t.status !== 'gereed' && t.status !== 'gesloten';
  var kinderen = t.kinderen.map(findItem).filter(Boolean);
  var lateN = kinderen.filter(function (it) { return isTeLaat(it, getPlan(it.id)); }).length;
  var behLijst = taakBehandelaars(t);
  var kidsHtml = kinderen.slice(0, KB_MAX_KINDEREN).map(function (it) {
    var plan = getPlan(it.id);
    var st = stDef(plan ? plan.werkstatus : 'nieuw');
    var itemTeLaat = isTeLaat(it, plan);
    return '<div class="kb-kind' + (zichtbaarSet[it.id] ? '' : ' gedimd') + '"'
      + ' title="' + escHtml((it.bron === 'so' ? 'S&O ' : 'Oplospunt ') + effNummer(it) + ' · ' + st.label + ' — ' + it.omschrijving) + '"'
      + ' onclick="event.stopPropagation();openDrawer(\'' + it.id + '\')">'
      + '<span class="st-dot" style="background:' + st.hex + '"></span>'
      + '<span class="kb-kind-num">' + escHtml(effNummer(it)) + '</span>'
      + '<span class="kb-kind-desc">' + escHtml(it.omschrijving) + '</span>'
      + (itemTeLaat ? '<span class="kb-kind-late">⚠</span>' : '')
      + '</div>';
  }).join('');
  if (kinderen.length > KB_MAX_KINDEREN) {
    kidsHtml += '<div class="kb-kind-meer">… nog ' + (kinderen.length - KB_MAX_KINDEREN) + ' item(s)</div>';
  }
  var ontbrekend = t.kinderen.length - kinderen.length;
  if (ontbrekend > 0) kidsHtml += '<div class="kb-kind-meer">⚠ ' + ontbrekend + ' item(s) niet geladen</div>';
  return '<div class="kb-card kb-taak-card' + (deadlineTeLaat || lateN ? ' kb-card-telaat' : '') + '"'
    + ' draggable="true" style="border-left-color:' + prio.hex + '"'
    + ' ondragstart="kbDragStart(event,\'' + t.id + '\')" ondragend="kbDragEnd(event)"'
    + ' onclick="openDrawer(\'' + t.id + '\')">'
    + '<div class="kb-card-top">'
    +   (t.projectnummer ? '<span class="badge badge-taak">' + escHtml(t.projectnummer) + '</span>' : '<span class="badge badge-taak">📋 Taak</span>')
    +   '<span class="kb-card-num">🔗 ' + t.kinderen.length + '</span>'
    +   (deadlineTeLaat ? '<span class="kb-late">⚠ deadline</span>' : (lateN ? '<span class="kb-late">' + lateN + ' te laat</span>' : ''))
    + '</div>'
    + '<div class="kb-card-titel">' + escHtml(t.titel || '(zonder naam)') + '</div>'
    + '<div class="kb-card-meta">'
    +   '<span class="cell-clip" style="max-width:150px">' + escHtml(taakProjectNaam(t)) + '</span>'
    +   (behLijst.length
          ? '<span>👤 ' + escHtml(behLijst.join(', ')) + '</span>'
          : '<span class="kb-geen-beh">👤 niet toegewezen</span>')
    +   (t.deadline ? '<span' + (deadlineTeLaat ? ' class="kb-deadline-late"' : '') + '>📅 ' + formatISO(t.deadline) + '</span>' : '')
    +   '<span class="kb-fase-tijd" title="Staat ' + escHtml(formatDuur(secSinds(t.statusSinds))) + ' in de fase ' + escHtml(stDef(t.status).label)
    +     ' · totale doorlooptijd ' + escHtml(formatDuur(somTijd(taakStatusTijd(t)))) + '">⏱ ' + formatDuur(secSinds(t.statusSinds)) + '</span>'
    + '</div>'
    + (kidsHtml ? '<div class="kb-kinderen">' + kidsHtml + '</div>' : '')
    + '</div>';
}

function kbColumnsHtml(taken, zichtbaarSet) {
  var cols = {};
  WERKSTATUS.forEach(function (st) { cols[st.key] = []; });
  taken.forEach(function (t) { (cols[t.status] || cols.nieuw).push(t); });
  return '<div class="kanban">' + WERKSTATUS.map(function (st) {
    var lijst = cols[st.key];
    var items = lijst.reduce(function (n, t) { return n + t.kinderen.length; }, 0);
    var cards = lijst.slice(0, KB_MAX_CARDS).map(function (t) { return kbTaakCardHtml(t, zichtbaarSet); }).join('');
    if (lijst.length > KB_MAX_CARDS) cards += '<div class="kb-meer">… nog ' + (lijst.length - KB_MAX_CARDS) + ' taken</div>';
    return '<div class="kb-col" data-status="' + st.key + '"'
      + ' ondragover="kbDragOver(event)" ondragleave="kbDragLeave(event)" ondrop="kbDrop(event,\'' + st.key + '\')">'
      + '<div class="kb-col-header"><span class="st-dot" style="background:' + st.hex + '"></span>' + st.label
      + '<span class="kb-col-count" title="' + lijst.length + (lijst.length === 1 ? ' taak · ' : ' taken · ') + items + ' gekoppelde items">' + lijst.length + ' · ' + items + '</span></div>'
      + '<div class="kb-col-body">' + (cards || '<div class="agenda-leeg">Leeg</div>') + '</div></div>';
  }).join('') + '</div>';
}

function renderKanban(data) {
  var el = document.getElementById('planbord-container');
  if (!workItems.length && !planstore.taken.length) { el.innerHTML = '<div class="empty-state">Laad eerst de bron-JSON\'s.</div>'; return; }
  var zichtbaarSet = {};
  data.forEach(function (it) { zichtbaarSet[it.id] = true; });
  var q = (document.getElementById('search-box').value || '').trim().toLowerCase();
  var taken = planstore.taken.filter(function (t) {
    if (!t.kinderen.length) return false;                       // niets gekoppeld → niets te plannen
    // Gesloten taken blijven zichtbaar in hun kolom — het planbord toont de
    // hele flow, de Backlog-tab is de plek om ze rustig na te lopen.
    if (!taakMatchesFilters(t, zichtbaarSet, q, true)) return false;
    return taakMatchesBehandelaar(t);
  });
  if (!taken.length) {
    var erZijnGekoppeldeTaken = planstore.taken.some(function (t) { return t.kinderen.length > 0; });
    el.innerHTML = '<div class="empty-state">' + (erZijnGekoppeldeTaken
      ? 'Geen taken binnen de huidige filters' + (planbordBehandelaar ? ' voor <strong>' + escHtml(planbordBehandelaar) + '</strong>' : '') + '.'
      : 'Nog niets te plannen. Koppel in de <strong>werkvoorraad</strong> meldingen of oplospunten aan een taak — pas dan verschijnen ze hier op het planbord.')
      + '</div>';
    return;
  }
  if (groupByProject.planbord) {
    var map = {};
    taken.forEach(function (t) {
      var naam = taakProjectNaam(t);
      if (!map[naam]) map[naam] = [];
      map[naam].push(t);
    });
    el.innerHTML = Object.keys(map).sort(function (a, b) { return map[b].length - map[a].length; }).map(function (naam) {
      var lijst = map[naam];
      var items = lijst.reduce(function (n, t) { return n + t.kinderen.length; }, 0);
      return '<div class="kb-group"><div class="kb-group-title">' + escHtml(naam)
        + '<span class="grp-count">' + lijst.length + ' taak/taken · ' + items + ' items</span></div>'
        + kbColumnsHtml(lijst, zichtbaarSet) + '</div>';
    }).join('');
  } else {
    el.innerHTML = kbColumnsHtml(taken, zichtbaarSet);
  }
}
var dragId = null;
function kbDragStart(e, id) { dragId = id; e.target.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function kbDragEnd(e) { e.target.classList.remove('dragging'); document.querySelectorAll('.kb-col.drag-over').forEach(function (c) { c.classList.remove('drag-over'); }); }
function kbDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function kbDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
// Slepen verzet de werkstatus van de taak; die wordt doorgezet naar alle
// gekoppelde meldingen en oplospunten (zie setTaakField).
function kbDrop(e, status) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (dragId) setTaakField(dragId, 'status', status);
  dragId = null;
}

// ── Groepeer-schakelaars ────────────────────────────────────────────────────
function toggleGroup(view, on) { groupByProject[view] = on; renderAll(); }

// ── Instellingen (deadlines) ────────────────────────────────────────────────
function setSetting(key, value) {
  var n = parseInt(value, 10);
  if (isNaN(n) || n < 1) return;
  planstore.settings[key] = n;
  saveStore();
  renderAll();
}
function setFaseMax(statusKey, waarde) {
  var n = parseInt(waarde, 10);
  if (isNaN(n) || n < 0) n = 0;
  if (!planstore.settings.faseMax) planstore.settings.faseMax = Object.assign({}, DEFAULT_SETTINGS.faseMax);
  planstore.settings.faseMax[statusKey] = n;
  saveStore();
  renderAll();
}
function syncSettingsInputs() {
  var a = document.getElementById('set-deadline-ol');
  var b = document.getElementById('set-deadline-so');
  if (a) a.value = planstore.settings.deadlineOl;
  if (b) b.value = planstore.settings.deadlineSo;
  var grid = document.getElementById('fase-max-grid');
  if (grid) {
    grid.innerHTML = WERKSTATUS.map(function (st) {
      return '<div class="fase-max-veld">'
        + '<label><span class="st-dot" style="background:' + st.hex + '"></span>' + escHtml(st.label) + '</label>'
        + '<div class="fase-max-invoer">'
        +   '<input type="number" min="0" step="1" value="' + faseMaxDagen(st.key) + '"'
        +   ' onchange="setFaseMax(\'' + st.key + '\', this.value)"><span>dagen</span>'
        + '</div></div>';
    }).join('');
  }
}

// ── Tab: Backlog (afgerond werk) ────────────────────────────────────────────
// Alles wat op Gereed of Gesloten staat: afgeronde taken met hun meldingen, en
// losse meldingen/oplospunten zonder taak. Blijft volledig bewerkbaar — zet de
// status terug en de taak staat weer op het planbord en in de werkvoorraad.
var backlogOpen = new Set();
var BL_COLS = 9;
function isAfgerond(t) { return t.status === 'gereed' || t.status === 'gesloten'; }
function isItemAfgerond(it) {
  var plan = getPlan(it.id);
  var ws = plan ? plan.werkstatus : 'nieuw';
  return ws === 'gereed' || ws === 'gesloten';
}
function toggleBacklogOpen(id) {
  if (backlogOpen.has(id)) backlogOpen.delete(id); else backlogOpen.add(id);
  renderBacklog();
}
function stBadgeHtml(ws) { var d = stDef(ws); return '<span class="st-badge"><span class="st-dot" style="background:' + d.hex + '"></span>' + d.label + '</span>'; }

// Moment waarop iets is afgerond — voor de sortering (nieuwste bovenaan).
function afgerondTijd(obj) {
  var d = obj.statusSinds ? new Date(obj.statusSinds) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
}

function urenUitsplitsingTekst(t) {
  var uren = t.werkelijkeUren || {};
  var sleutels = Object.keys(uren).filter(function (k) { return uren[k]; });
  if (!sleutels.length) return 'Nog geen uren vastgelegd — klik om ze in te vullen';
  return sleutels.map(function (k) { return urenSleutelLabel(k) + ': ' + formatUren(uren[k]); }).join('\n')
    + (t.urenGeregistreerdOp ? '\n\nVastgelegd ' + t.urenGeregistreerdOp : '');
}
function blTaakRowHtml(t) {
  var open = backlogOpen.has(t.id);
  var tijd = taakStatusTijd(t);
  var totaal = somTijd(tijd);
  var uren = taakWerkelijkeUrenTotaal(t);
  return '<tr class="bl-taak-row" data-taak-id="' + t.id + '" onclick="openDrawer(\'' + t.id + '\')">'
    + '<td class="wv-taak-first" onclick="event.stopPropagation()">'
    +   '<span class="wv-taak-toggle" title="Uitklappen / inklappen" onclick="toggleBacklogOpen(\'' + t.id + '\')">' + (open ? '▼' : '▶') + '</span>'
    +   '<span class="badge badge-taak">📋</span>'
    +   '<input class="wv-taak-titel" type="text" value="' + escAttr(t.titel) + '" placeholder="Naam van de taak…"'
    +   ' title="' + escHtml(t.titel || 'Naam van de taak') + '"'
    +   ' onchange="setTaakField(\'' + t.id + '\',\'titel\',this.value)">'
    + '</td>'
    + '<td onclick="event.stopPropagation()">'
    +   '<input class="wv-taak-nummer" type="text" value="' + escAttr(t.projectnummer || '') + '" placeholder="Projectnummer…"'
    +   ' onchange="setTaakField(\'' + t.id + '\',\'projectnummer\',this.value)">'
    + '</td>'
    + '<td><span class="wv-taak-count">🔗 ' + t.kinderen.length + '</span></td>'
    + '<td style="white-space:nowrap;font-weight:700">' + formatDuur(totaal) + '</td>'
    + '<td class="bl-uren" title="' + escHtml(urenUitsplitsingTekst(t)) + '" onclick="event.stopPropagation();openUrenDialoog(\'' + t.id + '\', \'\')">'
    +   (uren ? '<span class="bl-uren-waarde">' + formatUren(uren) + '</span>' : '<span class="bl-uren-leeg">+ invullen</span>')
    + '</td>'
    + '<td class="bl-fase-cel">' + faseBalkHtml(tijd) + '</td>'
    + '<td style="white-space:nowrap">' + escHtml(t.afgerondOp || '—') + '</td>'
    + '<td onclick="event.stopPropagation()">' + taakStatusSelect(t.id, t.status) + '</td>'
    + '<td onclick="event.stopPropagation()">' + taakBehandelaarSelect(t.id, t.behandelaar) + '</td>'
    + '</tr>';
}

function blItemRowHtml(it, kind) {
  var plan = getPlan(it.id);
  var ws = plan ? plan.werkstatus : 'nieuw';
  var tijd = itemStatusTijd(it);
  var bronBadge = it.bron === 'so'
    ? '<span class="badge badge-bron-so">S&amp;O</span>'
    : '<span class="badge badge-bron-ol">Oplospunt</span>';
  // Afgerond op = het moment waarop het item in deze eindstatus terechtkwam
  var afgerond = plan && plan.statusSinds ? new Date(plan.statusSinds) : null;
  return '<tr class="' + (kind ? 'wv-child' : '') + '" data-item-id="' + it.id + '" onclick="openDrawer(\'' + it.id + '\')">'
    + '<td class="cell-clip" title="' + escHtml(it.omschrijving) + '">'
    +   (kind ? '<span class="wv-child-marker">↳</span> ' : '') + bronBadge + ' ' + escHtml(it.omschrijving) + '</td>'
    + '<td class="bl-nummer">' + escHtml(effNummer(it)) + '</td>'
    + '<td class="cell-clip narrow" title="' + escHtml(it.project || '') + '">' + escHtml(it.project || '') + '</td>'
    + '<td style="white-space:nowrap">' + formatDuur(somTijd(tijd)) + '</td>'
    + '<td class="bl-uren-leeg">—</td>'
    + '<td class="bl-fase-cel">' + faseBalkHtml(tijd) + '</td>'
    + '<td style="white-space:nowrap">' + (afgerond && !isNaN(afgerond.getTime()) ? formatDate(afgerond) : '—') + '</td>'
    + '<td onclick="event.stopPropagation()">' + statusSelect(it.id, ws) + '</td>'
    + '<td onclick="event.stopPropagation()">' + behandelaarSelect(it.id, plan ? plan.behandelaar : '') + '</td>'
    + '</tr>';
}

function renderBacklog() {
  var container = document.getElementById('backlog-container');
  if (!container) return;
  var q = (document.getElementById('search-box').value || '').trim().toLowerCase();
  var taken = planstore.taken.filter(function (t) {
    if (!isAfgerond(t)) return false;
    if (!q) return true;
    if ((taakLabel(t) + ' ' + (t.omschrijving || '')).toLowerCase().indexOf(q) !== -1) return true;
    return t.kinderen.some(function (kid) {
      var it = findItem(kid);
      return it && (effNummer(it) + ' ' + it.project + ' ' + it.omschrijving).toLowerCase().indexOf(q) !== -1;
    });
  }).sort(function (a, b) { return afgerondTijd(b) - afgerondTijd(a); });

  var parentMap = {};
  planstore.taken.forEach(function (t) { t.kinderen.forEach(function (kid) { parentMap[kid] = 1; }); });
  var losse = getFiltered({ alleenAfgerond: true }).filter(function (it) { return !parentMap[it.id]; });

  var teller = document.getElementById('backlog-count');
  if (teller) teller.textContent = taken.length + ' afgeronde taak/taken · ' + losse.length + ' losse item(s)';
  var badge = document.getElementById('tab-backlog-badge');
  if (badge) {
    var n = taken.length + losse.length;
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
  }

  if (!taken.length && !losse.length) {
    container.innerHTML = '<div class="empty-state">Nog niets afgerond. Zodra je een taak of melding op <strong>Gereed</strong> of <strong>Gesloten</strong> zet, komt hij hier in de backlog te staan.</div>';
    return;
  }

  var html = '<table class="data-table bl-table"><thead><tr>'
    + '<th>Taak / melding</th><th>Projectnummer</th><th>Items / project</th><th>Doorlooptijd</th>'
    + '<th>Gemaakte uren</th><th>Verdeling over de fasen</th><th>Afgerond op</th><th>Status</th><th>Behandelaar</th>'
    + '</tr></thead><tbody>';
  taken.forEach(function (t) {
    html += blTaakRowHtml(t);
    if (backlogOpen.has(t.id)) {
      t.kinderen.forEach(function (kid) {
        var it = findItem(kid);
        if (!it) {
          html += '<tr class="wv-child wv-child-missing"><td colspan="' + BL_COLS + '">'
            + '<span class="wv-child-marker">↳</span> ⚠ Item niet geladen (' + escHtml(kid) + ')</td></tr>';
          return;
        }
        html += blItemRowHtml(it, true);
      });
    }
  });
  if (losse.length) {
    html += '<tr class="wv-separator-row"><td colspan="' + BL_COLS + '">Afgeronde losse meldingen &amp; oplospunten (' + losse.length + ')</td></tr>';
    html += losse.map(function (it) { return blItemRowHtml(it, false); }).join('');
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ── Tab: Te laat ────────────────────────────────────────────────────────────
// Blok 1: taken die langer in een planbordfase staan dan is toegestaan.
function renderFaseTeLaat() {
  var container = document.getElementById('fase-container');
  if (!container) return;
  var sub = document.getElementById('fase-subtitle');
  if (sub) {
    var limieten = WERKSTATUS.filter(function (st) { return faseMaxDagen(st.key); })
      .map(function (st) { return st.label + ' ' + faseMaxDagen(st.key) + ' d'; });
    sub.textContent = limieten.length
      ? 'Limieten: ' + limieten.join(' · ') + ' — in te stellen bij Team & instellingen'
      : 'Nog geen limieten ingesteld — doe dat bij Team & instellingen → Doorlooptijd & deadlines';
  }
  var rijen = takenTeLangInFase(false);
  var teller = document.getElementById('fase-count');
  if (teller) teller.textContent = rijen.length ? rijen.length + ' over de faselimiet' : '';
  if (!rijen.length) {
    container.innerHTML = '<div class="empty-state" style="padding:26px 16px">🎉 Geen enkele taak staat te lang in zijn huidige fase.</div>';
    return;
  }
  container.innerHTML = '<table class="data-table"><thead><tr>'
    + '<th>Projectnummer</th><th>Taak</th><th>Fase</th><th>Staat er</th><th>Max</th><th>Over</th>'
    + '<th>Items</th><th>Behandelaar</th><th>Status</th>'
    + '</tr></thead><tbody>' + rijen.map(function (r) {
      var t = r.taak;
      return '<tr class="row-telaat" onclick="openDrawer(\'' + t.id + '\')">'
        + '<td style="white-space:nowrap;font-weight:700">' + escHtml(t.projectnummer || '—') + '</td>'
        + '<td class="cell-clip" title="' + escHtml(t.titel) + '">' + escHtml(t.titel || '(zonder naam)') + '</td>'
        + '<td>' + stBadgeHtml(t.status) + '</td>'
        + '<td style="white-space:nowrap">' + formatDuur(r.inFase) + '</td>'
        + '<td style="white-space:nowrap;color:var(--muted)">' + r.maxDagen + ' d</td>'
        + '<td style="white-space:nowrap;color:var(--danger);font-weight:700">+ ' + formatDuur(r.over) + '</td>'
        + '<td><span class="wv-taak-count">🔗 ' + t.kinderen.length + '</span></td>'
        + '<td onclick="event.stopPropagation()">' + taakBehandelaarSelect(t.id, t.behandelaar) + '</td>'
        + '<td onclick="event.stopPropagation()">' + taakStatusSelect(t.id, t.status) + '</td>'
        + '</tr>';
    }).join('') + '</tbody></table>';
}

function renderTeLaat(data) {
  renderFaseTeLaat();
  var container = document.getElementById('telaat-container');
  var sub = document.getElementById('telaat-subtitle');
  if (sub) sub.textContent = 'Oplospunt > ' + planstore.settings.deadlineOl + ' dagen · servicemelding > ' + planstore.settings.deadlineSo + ' dagen na aanmaak, nog niet gereed';
  if (!workItems.length) { container.innerHTML = '<div class="empty-state">Laad eerst de bron-JSON\'s.</div>'; return; }
  var late = data.filter(function (it) { return isTeLaat(it, getPlan(it.id)); })
    .sort(function (a, b) { return dagenTeLaat(b) - dagenTeLaat(a); });
  document.getElementById('telaat-count').textContent = late.length + ' te laat';
  if (!late.length) { container.innerHTML = '<div class="empty-state">🎉 Geen items over de streefdatum binnen de huidige filters.</div>'; return; }
  var body = late.map(function (it) {
    var plan = getPlan(it.id);
    var sd = streefDatum(it);
    var over = dagenTeLaat(it);
    var beh = plan && plan.behandelaar ? plan.behandelaar : '';
    var bronBadge = it.bron === 'so' ? '<span class="badge badge-bron-so">S&amp;O</span>' : '<span class="badge badge-bron-ol">Oplospunt</span>';
    return '<tr class="row-telaat" onclick="openDrawer(\'' + it.id + '\')">'
      + '<td>' + bronBadge + '</td>'
      + '<td style="white-space:nowrap;font-weight:600">' + escHtml(effNummer(it)) + '</td>'
      + '<td class="cell-clip narrow" title="' + escAttr(it.project) + '">' + escHtml(it.project) + '</td>'
      + '<td class="cell-clip" title="' + escAttr(it.omschrijving) + '">' + escHtml(it.omschrijving) + '</td>'
      + '<td style="white-space:nowrap">' + formatDate(it.aangemaakt) + '</td>'
      + '<td style="white-space:nowrap;color:var(--danger);font-weight:700">' + (sd ? formatDate(sd) : '—') + '</td>'
      + '<td style="white-space:nowrap;color:var(--danger);font-weight:700">' + over + ' dg</td>'
      + '<td onclick="event.stopPropagation()">' + statusSelect(it.id, plan ? plan.werkstatus : 'nieuw') + '</td>'
      + '<td onclick="event.stopPropagation()">' + behandelaarSelect(it.id, beh) + '</td>'
      + '</tr>';
  }).join('');
  container.innerHTML = '<table class="data-table"><thead><tr>'
    + '<th>Bron</th><th>Nummer</th><th>Project</th><th>Omschrijving</th><th>Aangemaakt</th><th>Streefdatum</th><th>Te laat</th><th>Werkstatus</th><th>Behandelaar</th>'
    + '</tr></thead><tbody>' + body + '</tbody></table>';
}

// ── Werkelijke uren per kostenpost ──────────────────────────────────────────
// Bij het afronden van een taak leg je vast hoeveel uur er echt aan gewerkt is,
// verdeeld over de oorzaken/kostenposten die op het project spelen. De uren
// blijven op de taak staan (één bron van waarheid) en worden in de rapportage
// over de projecten van de gekoppelde meldingen verdeeld.
var urenDialoogTaakId = null, urenDialoogDoelStatus = '', urenDraft = {};

function urenSleutelLabel(sleutel) {
  return sleutel ? oorzaakLabel(sleutel) : 'Zonder oorzaak';
}
function urenDraftTotaal() {
  var n = 0;
  Object.keys(urenDraft).forEach(function (k) {
    var v = parseFloat(String(urenDraft[k]).replace(',', '.'));
    if (!isNaN(v) && v > 0) n += v;
  });
  return n;
}
// Welke kostenposten spelen er op deze taak? Alles wat op de taak staat, plus
// wat de gekoppelde meldingen zelf hebben, plus eerder ingevulde uren.
function urenSleutels(t) {
  var telling = taakOorzaakTelling(t);
  var sleutels = telling.lijst.slice();
  Object.keys(t.werkelijkeUren || {}).forEach(function (k) { if (sleutels.indexOf(k) === -1) sleutels.push(k); });
  if (telling.leeg || !sleutels.length) sleutels.push('');
  return sleutels;
}
function openUrenDialoog(taakId, doelStatus) {
  var t = findTaak(taakId);
  if (!t) return;
  urenDialoogTaakId = taakId;
  urenDialoogDoelStatus = doelStatus || '';
  urenDraft = {};
  urenSleutels(t).forEach(function (k) {
    var bestaand = (t.werkelijkeUren || {})[k];
    urenDraft[k] = bestaand ? String(bestaand).replace('.', ',') : '';
  });
  tekenUrenDialoog();
  document.getElementById('uren-modal').hidden = false;
  document.body.classList.add('modal-open');
}
function tekenUrenDialoog() {
  var t = findTaak(urenDialoogTaakId);
  if (!t) return;
  var telling = taakOorzaakTelling(t);
  var geschat = 0;
  t.kinderen.forEach(function (kid) {
    var pl = getPlan(kid);
    if (!pl) return;
    var u = parseFloat(String(pl.uren == null ? '' : pl.uren).replace(',', '.'));
    if (!isNaN(u) && u > 0) geschat += u;
  });
  var rijen = Object.keys(urenDraft).map(function (k) {
    var aantal = k ? (telling.telling[k] || 0) : telling.leeg;
    return '<div class="uren-regel" style="--oz:' + (k ? oorzaakGroepHex(k) : '#94a3b8') + '">'
      + '<span class="uren-oorzaak">'
      +   escHtml(urenSleutelLabel(k))
      +   '<i>' + aantal + ' melding' + (aantal === 1 ? '' : 'en') + '</i>'
      + '</span>'
      + '<span class="uren-invoer">'
      +   '<input type="text" inputmode="decimal" value="' + escHtml(urenDraft[k]) + '" placeholder="0"'
      +   ' oninput="urenInvoerChanged(\'' + escAttr(k) + '\', this.value)"><span>uur</span>'
      + '</span>'
      + '</div>';
  }).join('');
  var extraOpties = OORZAAK_GROEPEN.reduce(function (acc, g) {
    if (g.subs.length) {
      acc.push('<optgroup label="' + escAttr(g.label) + '"><option value="' + g.key + '">' + escHtml(g.label) + ' — algemeen</option>'
        + g.subs.map(function (sub) {
            var v = g.key + '|' + sub;
            return '<option value="' + escAttr(v) + '">' + escHtml(sub) + '</option>';
          }).join('') + '</optgroup>');
    } else {
      acc.push('<option value="' + g.key + '">' + escHtml(g.label) + '</option>');
    }
    return acc;
  }, ['<option value="">— kostenpost toevoegen —</option>']).join('');

  document.getElementById('uren-modal-body').innerHTML =
      '<div class="modal-kop"><div>'
    +   '<div class="modal-titel">Werkelijke uren registreren</div>'
    +   '<div class="modal-sub">' + escHtml(taakLabel(t)) + ' · ' + t.kinderen.length + ' gekoppelde melding(en)'
    +   (urenDialoogDoelStatus ? ' · gaat naar <strong>' + escHtml(stDef(urenDialoogDoelStatus).label) + '</strong>' : '') + '</div>'
    + '</div><button class="drawer-close" onclick="sluitUrenDialoog()">✕</button></div>'
    + '<div class="modal-inhoud">'
    +   '<p class="modal-uitleg">Hoeveel uur is er daadwerkelijk aan gewerkt? Verdeel de uren over de kostenposten die op dit project spelen — zo komen ze in de rapportage bij de juiste oorzaak terecht.</p>'
    +   '<div class="uren-lijst">' + rijen + '</div>'
    +   '<div class="uren-toevoegen">'
    +     '<select id="uren-extra" onchange="voegUrenRegelToe(this.value)">' + extraOpties + '</select>'
    +   '</div>'
    +   '<div class="uren-totaal">Totaal <strong id="uren-totaal">' + formatUren(urenDraftTotaal()) + '</strong>'
    +     (geschat ? '<span class="uren-geschat">geschat was ' + formatUren(geschat) + '</span>' : '') + '</div>'
    + '</div>'
    + '<div class="modal-voet">'
    +   '<button class="mini-btn" onclick="sluitUrenDialoog()">Annuleren</button>'
    +   '<button class="btn-primary" onclick="bevestigUren()">' + (urenDialoogDoelStatus ? 'Opslaan &amp; op gereed zetten' : 'Uren opslaan') + '</button>'
    + '</div>';
}
function urenInvoerChanged(sleutel, waarde) {
  urenDraft[sleutel] = waarde;
  var el = document.getElementById('uren-totaal');
  if (el) el.textContent = formatUren(urenDraftTotaal());
}
function voegUrenRegelToe(waarde) {
  if (!waarde) return;
  if (!(waarde in urenDraft)) urenDraft[waarde] = '';
  tekenUrenDialoog();
}
function bevestigUren() {
  var t = findTaak(urenDialoogTaakId);
  if (!t) { sluitUrenDialoog(); return; }
  var uren = {}, totaal = 0;
  Object.keys(urenDraft).forEach(function (k) {
    var v = parseFloat(String(urenDraft[k]).replace(',', '.'));
    if (isNaN(v) || v <= 0) return;
    uren[k] = Math.round(v * 100) / 100;
    totaal += uren[k];
  });
  if (!totaal) {
    if (!confirm('Er zijn geen uren ingevuld.\n\nOK = toch doorgaan zonder urenregistratie\nAnnuleren = terug naar het invulscherm')) return;
  }
  t.werkelijkeUren = uren;
  t.urenGeregistreerdOp = nowStamp();
  logTaakHist(t, 'Werkelijke uren vastgelegd: ' + formatUren(totaal)
    + (Object.keys(uren).length ? ' (' + Object.keys(uren).map(function (k) { return urenSleutelLabel(k) + ' ' + formatUren(uren[k]); }).join(', ') + ')' : ''));
  var doel = urenDialoogDoelStatus;
  sluitUrenDialoog(true);
  if (doel) setTaakField(t.id, 'status', doel, true);
  else { saveStore(); renderAll(); }
  toastMelding(formatUren(totaal) + ' geregistreerd op "' + taakLabel(t) + '"');
}
function sluitUrenDialoog(zonderHertekenen) {
  var el = document.getElementById('uren-modal');
  if (el) el.hidden = true;
  document.body.classList.remove('modal-open');
  urenDialoogTaakId = null;
  urenDialoogDoelStatus = '';
  urenDraft = {};
  // Zonder hertekenen zou de statuskeuze op 'Gereed' blijven staan terwijl de
  // taak dat niet is.
  if (!zonderHertekenen) renderAll();
}
function taakWerkelijkeUrenTotaal(t) {
  var n = 0;
  Object.keys(t.werkelijkeUren || {}).forEach(function (k) { n += t.werkelijkeUren[k] || 0; });
  return n;
}
// Verdeelt de uren van een taak over project + oorzaak, op basis van de
// gekoppelde meldingen. Levert [{project, oorzaak, uren}].
function urenPerProjectEnOorzaak() {
  var uit = [];
  planstore.taken.forEach(function (t) {
    var uren = t.werkelijkeUren || {};
    var kinderen = t.kinderen.map(findItem).filter(Boolean);
    Object.keys(uren).forEach(function (oz) {
      var totaal = uren[oz];
      if (!totaal) return;
      var relevant = kinderen.filter(function (it) {
        var pl = getPlan(it.id);
        return ((pl && pl.oorzaak) || '') === oz;
      });
      if (!relevant.length) relevant = kinderen;
      if (!relevant.length) {
        uit.push({ project: '(geen gekoppelde meldingen)', oorzaak: oz, uren: totaal, taak: t });
        return;
      }
      var perProject = {};
      relevant.forEach(function (it) {
        var naam = it.project || 'Onbekend project';
        perProject[naam] = (perProject[naam] || 0) + 1;
      });
      Object.keys(perProject).forEach(function (naam) {
        uit.push({ project: naam, oorzaak: oz, uren: totaal * perProject[naam] / relevant.length, taak: t });
      });
    });
  });
  return uit;
}

// ── Weekstartbord (A3, print) ───────────────────────────────────────────────
// Eén vel om met het team de week door te nemen: wat loopt vast, wat is te laat,
// wie pakt wat op en wat spreken we af. Bewust met aankruisvakjes en schrijf-
// regels, zodat je er tijdens het overleg op kunt werken.
function isoWeek(d) {
  var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);      // donderdag van deze week
  var eerste = new Date(t.getFullYear(), 0, 4);
  eerste.setDate(eerste.getDate() - ((eerste.getDay() + 6) % 7) + 3);
  return 1 + Math.round((t - eerste) / (7 * 86400000));
}
// Korte omschrijving van de actieve filters, zodat op papier duidelijk is
// waar het overzicht over gaat.
function actieveFilterTekst() {
  var labels = { 'ms-bron': 'Bron', 'ms-bedrijf': 'Bedrijf', 'ms-project': 'Project', 'ms-nummer': 'Nummer', 'ms-status': 'Werkstatus', 'ms-behandelaar': 'Behandelaar', 'ms-prio': 'Prioriteit' };
  var delen = [];
  Object.keys(selections).forEach(function (k) {
    if (!selections[k].size) return;
    var waarden = Array.prototype.slice.call(Array.from(selections[k]));
    delen.push(labels[k] + ': ' + waarden.slice(0, 3).join(', ') + (waarden.length > 3 ? ' +' + (waarden.length - 3) : ''));
  });
  var q = (document.getElementById('search-box').value || '').trim();
  if (q) delen.push('zoekterm "' + q + '"');
  return delen.join('  ·  ');
}
var WS_VAKJES = '<span class="ws-keuze"><i></i><i></i><i></i></span>';

function bouwWeekstart() {
  var data = getFiltered();
  var nu = new Date();
  var parentMap = {};
  planstore.taken.forEach(function (t) { t.kinderen.forEach(function (kid) { parentMap[kid] = t.id; }); });

  // Kerncijfers
  var totaal = 0, nieuw = 0, lopend = 0, gereed = 0, telaat = 0;
  workItems.forEach(function (it) {
    var plan = getPlan(it.id);
    var ws = plan ? plan.werkstatus : 'nieuw';
    if (ws === 'gesloten') return;
    totaal++;
    if (ws === 'nieuw' || ws === 'beoordeeld') nieuw++;
    if (ws === 'gepland' || ws === 'uitvoering' || ws === 'wachten') lopend++;
    if (ws === 'gereed') gereed++;
    if (isTeLaat(it, plan)) telaat++;
  });
  var actieveTaken = planstore.taken.filter(function (t) { return t.kinderen.length && !isAfgerond(t); });
  var kpis = [
    { n: totaal, l: 'werkvoorraad' },
    { n: nieuw, l: 'nieuw / ongepland' },
    { n: lopend, l: 'gepland / in uitvoering' },
    { n: telaat, l: 'over de streefdatum', rood: true },
    { n: actieveTaken.length, l: 'taken op het planbord' },
    { n: gereed, l: 'gereed (te sluiten)' }
  ];

  // ① Taken die te lang in hun fase staan
  var faseRijen = takenTeLangInFase(false).slice(0, 10);

  // ② Meldingen over de streefdatum, gebundeld per project
  var perProject = {};
  data.forEach(function (it) {
    var plan = getPlan(it.id);
    if (!isTeLaat(it, plan)) return;
    var naam = it.project || 'Onbekend project';
    if (!perProject[naam]) perProject[naam] = { n: 0, oudste: 0, so: 0, ol: 0, behandelaars: {}, taak: 0 };
    var g = perProject[naam];
    g.n++;
    g.oudste = Math.max(g.oudste, dagenTeLaat(it));
    if (it.bron === 'so') g.so++; else g.ol++;
    if (plan && plan.behandelaar) g.behandelaars[plan.behandelaar] = (g.behandelaars[plan.behandelaar] || 0) + 1;
    if (parentMap[it.id]) g.taak++;
  });
  var projectRijen = Object.keys(perProject).map(function (naam) {
    var g = perProject[naam];
    var beh = Object.keys(g.behandelaars).sort(function (a, b) { return g.behandelaars[b] - g.behandelaars[a]; });
    return { naam: naam, n: g.n, oudste: g.oudste, so: g.so, ol: g.ol, taak: g.taak, wie: beh.length ? beh[0] + (beh.length > 1 ? ' +' + (beh.length - 1) : '') : '' };
  }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12);

  // ③ Wie pakt wat op — lopende taken per behandelaar
  var perBeh = {};
  actieveTaken.forEach(function (t) {
    var namen = taakBehandelaars(t);
    var sleutel = namen.length ? namen[0] : 'Niet toegewezen';
    if (!perBeh[sleutel]) perBeh[sleutel] = [];
    perBeh[sleutel].push(t);
  });
  var behNamen = Object.keys(perBeh).sort(function (a, b) {
    if (a === 'Niet toegewezen') return 1;
    if (b === 'Niet toegewezen') return -1;
    return perBeh[b].length - perBeh[a].length;
  });

  var filterTekst = actieveFilterTekst();
  var html = ''
    + '<header class="ws-kop">'
    +   '<div><h1>Weekstart — Service &amp; Onderhoud</h1>'
    +     '<div class="ws-sub">BAM Wood Concepts · week ' + isoWeek(nu) + ' · ' + formatDate(nu) + (filterTekst ? ' · selectie: ' + escHtml(filterTekst) : '') + '</div></div>'
    +   '<div class="ws-aanwezig"><span>Aanwezig</span><span class="ws-lijn"></span></div>'
    + '</header>'
    + '<div class="ws-kpi">' + kpis.map(function (k) {
        return '<div class="ws-kpi-vak' + (k.rood ? ' rood' : '') + '"><b>' + k.n + '</b><span>' + k.l + '</span></div>';
      }).join('') + '</div>'
    + '<div class="ws-kolommen"><div class="ws-kol ws-kol-breed">';

  // ① ------------------------------------------------------------------
  html += '<section class="ws-blok"><h2><i>1</i> Loopt vast — taken te lang in hun fase'
    + '<span class="ws-legenda">' + WS_VAKJES + ' doen · niet · later</span></h2>';
  if (faseRijen.length) {
    html += '<table class="ws-tabel"><thead><tr>'
      + '<th>Nr.</th><th>Taak</th><th>Fase</th><th>Staat er</th><th>Over</th><th>Wie</th><th class="ws-kol-keuze">Besluit</th><th>Afspraak</th>'
      + '</tr></thead><tbody>' + faseRijen.map(function (r) {
        var t = r.taak;
        var wie = taakBehandelaars(t);
        return '<tr>'
          + '<td class="ws-nr">' + escHtml(t.projectnummer || '—') + '</td>'
          + '<td class="ws-naam">' + escHtml(t.titel || '(zonder naam)') + ' <span class="ws-mini">🔗 ' + t.kinderen.length + '</span></td>'
          + '<td>' + escHtml(stDef(t.status).label) + '</td>'
          + '<td>' + formatDuur(r.inFase) + '</td>'
          + '<td class="ws-over">+ ' + formatDuur(r.over) + '</td>'
          + '<td>' + escHtml(wie.length ? wie.join(', ') : '—') + '</td>'
          + '<td class="ws-kol-keuze">' + WS_VAKJES + '</td>'
          + '<td class="ws-schrijf"></td>'
          + '</tr>';
      }).join('') + '</tbody></table>';
  } else {
    html += '<div class="ws-leeg">Geen enkele taak staat langer in een fase dan afgesproken.</div>';
  }
  html += '</section>';

  // ② ------------------------------------------------------------------
  html += '<section class="ws-blok"><h2><i>2</i> Over de streefdatum — per project'
    + '<span class="ws-legenda">' + escHtml(telaat + ' items te laat') + '</span></h2>';
  if (projectRijen.length) {
    html += '<table class="ws-tabel"><thead><tr>'
      + '<th>Project</th><th>Te laat</th><th>S&amp;O</th><th>Opl.</th><th>In taak</th><th>Oudste</th><th>Wie</th><th class="ws-kol-keuze">Besluit</th><th>Afspraak</th>'
      + '</tr></thead><tbody>' + projectRijen.map(function (r) {
        return '<tr>'
          + '<td class="ws-naam">' + escHtml(r.naam) + '</td>'
          + '<td class="ws-over">' + r.n + '</td>'
          + '<td>' + r.so + '</td><td>' + r.ol + '</td>'
          + '<td>' + r.taak + '/' + r.n + '</td>'
          + '<td>' + r.oudste + ' d</td>'
          + '<td>' + escHtml(r.wie || '—') + '</td>'
          + '<td class="ws-kol-keuze">' + WS_VAKJES + '</td>'
          + '<td class="ws-schrijf"></td>'
          + '</tr>';
      }).join('') + '</tbody></table>';
  } else {
    html += '<div class="ws-leeg">Niets over de streefdatum binnen deze selectie.</div>';
  }
  html += '</section></div><div class="ws-kol">';

  // ③ ------------------------------------------------------------------
  html += '<section class="ws-blok"><h2><i>3</i> Wie pakt wat op</h2>';
  if (behNamen.length) {
    html += '<div class="ws-personen">' + behNamen.map(function (naam) {
      var lijst = perBeh[naam].slice().sort(function (a, b) { return (a.deadline || '9999').localeCompare(b.deadline || '9999'); });
      return '<div class="ws-persoon' + (naam === 'Niet toegewezen' ? ' ws-persoon-open' : '') + '">'
        + '<div class="ws-persoon-kop">' + escHtml(naam) + '<span>' + lijst.length + ' taak/taken</span></div>'
        + lijst.slice(0, 6).map(function (t) {
            var over = faseOverschrijding(t);
            return '<div class="ws-persoon-regel"><i></i>'
              + '<span class="ws-nr">' + escHtml(t.projectnummer || '—') + '</span> '
              + escHtml(t.titel || '(zonder naam)')
              + '<span class="ws-persoon-meta">' + escHtml(stDef(t.status).label)
              + (t.deadline ? ' · ' + formatISO(t.deadline) : '')
              + (over ? ' · <b>+' + formatDuur(over.over) + '</b>' : '') + '</span></div>';
          }).join('')
        + (lijst.length > 6 ? '<div class="ws-persoon-meer">… nog ' + (lijst.length - 6) + ' taak/taken</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  } else {
    html += '<div class="ws-leeg">Nog geen taken met gekoppeld werk op het planbord.</div>';
  }
  html += '</section>';

  // ④ ------------------------------------------------------------------
  html += '<section class="ws-blok ws-blok-afspraken"><h2><i>4</i> Afspraken deze week</h2>'
    + '<table class="ws-tabel ws-afspraken"><thead><tr><th>Actie</th><th>Wie</th><th>Wanneer</th><th>✓</th></tr></thead><tbody>';
  for (var i = 0; i < 9; i++) {
    html += '<tr><td class="ws-schrijf"></td><td class="ws-schrijf"></td><td class="ws-schrijf"></td><td class="ws-kol-vink"><i></i></td></tr>';
  }
  html += '</tbody></table></section></div></div>'
    + '<footer class="ws-voet"><span>S&amp;O Planmodule · afgedrukt ' + nowStamp() + '</span>'
    + '<span>Volgende weekstart: ______________</span></footer>';

  document.getElementById('ws-vel').innerHTML = html;
}
// Papierformaat alleen instellen zolang het bord openstaat — anders zou een
// gewone Ctrl+P van het dashboard ook op A3 liggend uitkomen.
function zetPaginaFormaat(aan) {
  var doel = document.head || document.body;
  if (!doel || !doel.appendChild) return;
  var st = document.getElementById('ws-page-style');
  if (aan) {
    if (st) return;
    st = document.createElement('style');
    st.id = 'ws-page-style';
    st.textContent = '@page { size: A3 landscape; margin: 8mm; }';
    doel.appendChild(st);
  } else if (st && st.parentNode) {
    st.parentNode.removeChild(st);
  }
}
function openWeekstart() {
  bouwWeekstart();
  document.getElementById('weekstart-sheet').hidden = false;
  document.body.classList.add('weekstart-open');
  zetPaginaFormaat(true);
}
function sluitWeekstart() {
  var el = document.getElementById('weekstart-sheet');
  if (el) el.hidden = true;
  document.body.classList.remove('weekstart-open');
  zetPaginaFormaat(false);
}

// ── Tab: Agenda ─────────────────────────────────────────────────────────────
function renderAgenda(data) {
  var el = document.getElementById('agenda-grid');
  if (!workItems.length) { el.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Laad eerst de bron-JSON\'s.</div>'; return; }
  var now = new Date(); now.setHours(0,0,0,0);
  var in7 = new Date(now.getTime() + 7 * 86400000);
  var in14 = new Date(now.getTime() + 14 * 86400000);
  var buckets = { telaat: [], week: [], volgende: [], ongepland: [] };
  data.forEach(function (it) {
    var plan = getPlan(it.id);
    var ws = plan ? plan.werkstatus : 'nieuw';
    if (ws === 'gereed' || ws === 'gesloten') return;
    var g = plan && plan.gepland ? parseDate(plan.gepland) : null;
    if (!g) { buckets.ongepland.push({ it: it, d: null }); return; }
    if (g < now) buckets.telaat.push({ it: it, d: g });
    else if (g < in7) buckets.week.push({ it: it, d: g });
    else if (g < in14) buckets.volgende.push({ it: it, d: g });
    else buckets.ongepland.push({ it: it, d: g, later: true });
  });
  ['telaat', 'week', 'volgende'].forEach(function (k) { buckets[k].sort(function (a, b) { return a.d - b.d; }); });
  var defs = [
    { key: 'telaat', label: '⚠ Over datum', rood: true },
    { key: 'week', label: 'Komende 7 dagen' },
    { key: 'volgende', label: 'Week daarna' },
    { key: 'ongepland', label: 'Ongepland / later' }
  ];
  el.innerHTML = defs.map(function (d) {
    var rows = buckets[d.key];
    var body = rows.slice(0, 80).map(function (e) {
      var it = e.it, plan = getPlan(it.id);
      var beh = plan && plan.behandelaar ? ' · 👤 ' + escHtml(plan.behandelaar) : '';
      var dat = e.d ? '<div class="agenda-datum' + (d.key === 'telaat' ? ' telaat' : '') + '">' + formatDate(e.d) + (e.later ? ' (later)' : '') + '</div>' : '';
      return '<div class="agenda-item" onclick="openDrawer(\'' + it.id + '\')">' + dat
        + '<div class="cell-clip" style="max-width:none;font-weight:600">' + escHtml(it.omschrijving) + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:3px">' + escHtml(it.project) + beh + '</div></div>';
    }).join('');
    return '<div class="agenda-col"><div class="agenda-col-header' + (d.rood ? ' rood' : '') + '">' + d.label
      + '<span style="font-size:12px;color:var(--muted)">' + rows.length + '</span></div>'
      + '<div class="agenda-col-body">' + (body || '<div class="agenda-leeg">Geen items</div>') + '</div></div>';
  }).join('');
}

// ── Tab: Rapportage ─────────────────────────────────────────────────────────
var rapportUrenProject = '';   // '' = alle projecten
function setRapportUrenProject(naam) {
  rapportUrenProject = naam;
  renderRapportage(getFiltered());
}
function renderRapportage(data) {
  var el = document.getElementById('report-grid');
  if (!workItems.length) { el.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Laad eerst de bron-JSON\'s.</div>'; return; }
  var now = new Date();
  var perStatus = {}, perBeh = {}, perPrio = {}, perProject = {}, perOorzaak = {}, perKostensoort = {};
  var leeftijd = { '0-30': 0, '31-90': 0, '91-180': 0, '180+': 0 };
  data.forEach(function (it) {
    var plan = getPlan(it.id);
    var ws = plan ? plan.werkstatus : 'nieuw';
    perStatus[ws] = (perStatus[ws] || 0) + 1;
    var beh = (plan && plan.behandelaar) || '(niet toegewezen)';
    if (!perBeh[beh]) perBeh[beh] = { open: 0, gereed: 0 };
    (ws === 'gereed' || ws === 'gesloten') ? perBeh[beh].gereed++ : perBeh[beh].open++;
    var prio = (plan && plan.prio) || 'normaal';
    perPrio[prio] = (perPrio[prio] || 0) + 1;
    perProject[it.project || 'Onbekend'] = (perProject[it.project || 'Onbekend'] || 0) + 1;
    var oz = plan && plan.oorzaak;
    if (oz) {
      perOorzaak[oz] = (perOorzaak[oz] || 0) + 1;
      var ozGroep = splitOorzaak(oz).groep;
      if (ozGroep) perKostensoort[ozGroep] = (perKostensoort[ozGroep] || 0) + 1;
    }
    if (it.aangemaakt) {
      var d = daysBetween(it.aangemaakt, now);
      if (d <= 30) leeftijd['0-30']++; else if (d <= 90) leeftijd['31-90']++;
      else if (d <= 180) leeftijd['91-180']++; else leeftijd['180+']++;
    }
  });
  var html = '';
  // Per werkstatus
  html += reportCard('Werkvoorraad per werkstatus', 'Binnen de huidige filters', hbarList(
    WERKSTATUS.filter(function (s) { return perStatus[s.key]; }).map(function (s) { return { label: s.label, n: perStatus[s.key], hex: s.hex }; }), data.length));
  // Per behandelaar
  var behRows = Object.keys(perBeh).sort(function (a, b) { return perBeh[b].open - perBeh[a].open; });
  var behMax = Math.max.apply(null, behRows.map(function (b) { return perBeh[b].open + perBeh[b].gereed; }).concat([1]));
  html += reportCard('Werklast per behandelaar', 'Open (oranje) vs. gereed/gesloten (groen)',
    behRows.map(function (b) {
      var v = perBeh[b], t = v.open + v.gereed;
      return '<div class="hbar-row"><div class="hbar-label" title="' + escAttr(b) + '">' + escHtml(b) + '</div>'
        + '<div class="hbar-stack">'
        + '<div style="width:' + (v.open / behMax * 100) + '%;background:var(--open)"></div>'
        + '<div style="width:' + (v.gereed / behMax * 100) + '%;background:var(--closed)"></div>'
        + '</div><div class="hbar-num">' + t + '</div></div>';
    }).join(''));
  // Per prioriteit
  html += reportCard('Per prioriteit', 'Binnen de huidige filters', hbarList(
    PRIORITEIT.filter(function (p) { return perPrio[p.key]; }).map(function (p) { return { label: p.label, n: perPrio[p.key], hex: p.hex }; }), data.length));
  // Leeftijd
  var ageColors = { '0-30': '#16a34a', '31-90': '#2563eb', '91-180': '#d97706', '180+': '#dc2626' };
  html += reportCard('Leeftijd werkvoorraad', 'Dagen sinds aanmaak in de bron', hbarList(
    Object.keys(leeftijd).filter(function (k) { return leeftijd[k]; }).map(function (k) { return { label: k + ' dagen', n: leeftijd[k], hex: ageColors[k] }; }), data.length));
  // Top projecten
  var projRows = Object.keys(perProject).sort(function (a, b) { return perProject[b] - perProject[a]; }).slice(0, 12);
  html += reportCard('Top projecten', 'Meeste items in werkvoorraad', hbarList(
    projRows.map(function (p) { return { label: p, n: perProject[p], hex: '#2563eb' }; }), data.length));
  // Gemaakte uren per oorzaak — vastgelegd bij het afronden van een taak.
  // Standaard alle projecten bij elkaar; met de keuzelijst zoom je in op één project.
  var urenRegels = urenPerProjectEnOorzaak();
  var urenPerProject = {};
  urenRegels.forEach(function (r) { urenPerProject[r.project] = (urenPerProject[r.project] || 0) + r.uren; });
  var urenProjectNamen = Object.keys(urenPerProject).sort(function (a, b) { return urenPerProject[b] - urenPerProject[a]; });
  if (rapportUrenProject && urenProjectNamen.indexOf(rapportUrenProject) === -1) rapportUrenProject = '';
  var urenAlles = urenRegels.reduce(function (n, r) { return n + r.uren; }, 0);
  var urenSelectie = rapportUrenProject
    ? urenRegels.filter(function (r) { return r.project === rapportUrenProject; })
    : urenRegels;
  var gemaaktPerOorzaak = {};
  urenSelectie.forEach(function (r) { gemaaktPerOorzaak[r.oorzaak] = (gemaaktPerOorzaak[r.oorzaak] || 0) + r.uren; });
  var gemaaktRows = Object.keys(gemaaktPerOorzaak)
    .sort(function (a, b) { return gemaaktPerOorzaak[b] - gemaaktPerOorzaak[a]; })
    .map(function (k) {
      return { label: urenSleutelLabel(k), n: gemaaktPerOorzaak[k], tekst: formatUren(gemaaktPerOorzaak[k]),
               hex: k ? oorzaakGroepHex(k) : '#94a3b8' };
    });
  var urenSelTotaal = urenSelectie.reduce(function (n, r) { return n + r.uren; }, 0);
  var takenMetUren = planstore.taken.filter(function (t) { return taakWerkelijkeUrenTotaal(t) > 0; }).length;
  var projectKeuze = '<select onchange="setRapportUrenProject(this.value)">'
    + '<option value=""' + (rapportUrenProject ? '' : ' selected') + '>Alle projecten — ' + formatUren(urenAlles) + '</option>'
    + urenProjectNamen.map(function (naam) {
        return '<option value="' + escHtml(naam) + '"' + (naam === rapportUrenProject ? ' selected' : '') + '>'
          + escHtml(naam) + ' — ' + formatUren(urenPerProject[naam]) + '</option>';
      }).join('') + '</select>';
  html += reportCard('Gemaakte uren per oorzaak',
    rapportUrenProject
      ? 'Project: ' + escHtml(rapportUrenProject) + ' · ' + formatUren(urenSelTotaal)
      : 'Alle projecten samen · ' + formatUren(urenAlles) + ' over ' + takenMetUren + ' afgeronde taak/taken — kies rechts een project om in te zoomen',
    gemaaktRows.length
      ? hbarList(gemaaktRows, urenSelTotaal)
        + '<div class="uren-voet">Vastgelegd bij het afronden van een taak; over de projecten verdeeld naar de gekoppelde meldingen.</div>'
      : '<div class="agenda-leeg">Nog geen uren vastgelegd — die vraagt de module zodra een taak van In uitvoering of Wacht op derden naar Gereed gaat</div>',
    projectKeuze);

  // Kostensoort (hoofdgroep van de oorzaak)
  var ksRows = OORZAAK_GROEPEN.filter(function (g) { return perKostensoort[g.key]; })
    .map(function (g) { return { label: g.label, n: perKostensoort[g.key], hex: g.hex }; })
    .sort(function (a, b) { return b.n - a.n; });
  html += reportCard('Kostensoort', 'Faalkosten, opdrachtkosten, meerwerk en garantiekosten', ksRows.length
    ? hbarList(ksRows, data.length)
    : '<div class="agenda-leeg">Nog geen kostensoort vastgelegd — kies er een via het detailpaneel</div>');
  // Geschatte uren per kostensoort en per oorzaak — waar gaat de tijd naartoe?
  var urenPerKost = {}, urenPerOorzaak = {}, urenTotaal = 0, itemsMetUren = 0;
  data.forEach(function (it) {
    var plan = getPlan(it.id);
    if (!plan) return;
    var u = parseFloat(String(plan.uren == null ? '' : plan.uren).replace(',', '.'));
    if (isNaN(u) || u <= 0) return;
    urenTotaal += u;
    itemsMetUren++;
    var oz = plan.oorzaak || '';
    var ozSleutel = oz || '(geen oorzaak vastgelegd)';
    urenPerOorzaak[ozSleutel] = (urenPerOorzaak[ozSleutel] || 0) + u;
    var groep = oz ? splitOorzaak(oz).groep : '';
    var kostSleutel = groep || '(geen kostensoort)';
    urenPerKost[kostSleutel] = (urenPerKost[kostSleutel] || 0) + u;
  });
  var urenSub = itemsMetUren
    ? formatUren(urenTotaal) + ' over ' + itemsMetUren + ' item(s) met geschatte uren'
    : 'Vul "Geschatte uren" in bij een melding om dit te vullen';
  var urenKostRows = Object.keys(urenPerKost).sort(function (a, b) { return urenPerKost[b] - urenPerKost[a]; })
    .map(function (k) {
      var g = oorzaakGroepDef(k);
      return { label: g ? g.label : k, n: urenPerKost[k], tekst: formatUren(urenPerKost[k]), hex: g ? g.hex : '#94a3b8' };
    });
  html += reportCard('Geschatte uren per kostensoort', urenSub, urenKostRows.length
    ? hbarList(urenKostRows, urenTotaal)
    : '<div class="agenda-leeg">Nog geen geschatte uren ingevuld</div>');
  var urenOzRows = Object.keys(urenPerOorzaak).sort(function (a, b) { return urenPerOorzaak[b] - urenPerOorzaak[a]; })
    .slice(0, 12).map(function (k) {
      var bekend = k.indexOf('(') !== 0;
      return { label: bekend ? oorzaakLabel(k) : k, n: urenPerOorzaak[k], tekst: formatUren(urenPerOorzaak[k]),
               hex: bekend ? oorzaakGroepHex(k) : '#94a3b8' };
    });
  html += reportCard('Geschatte uren per oorzaak', 'Vooraf ingeschat — ' + urenSub.toLowerCase(), urenOzRows.length
    ? hbarList(urenOzRows, urenTotaal)
    : '<div class="agenda-leeg">Nog geen geschatte uren ingevuld</div>');

  // Oorzaken (kostensoort + specificatie)
  var ozRows = Object.keys(perOorzaak).sort(function (a, b) { return perOorzaak[b] - perOorzaak[a]; });
  html += reportCard('Geregistreerde oorzaken', 'Kostensoort met specificatie, alleen items waar een oorzaak is vastgelegd', ozRows.length
    ? hbarList(ozRows.map(function (o) { return { label: oorzaakLabel(o), n: perOorzaak[o], hex: oorzaakGroepHex(o) }; }), data.length)
    : '<div class="agenda-leeg">Nog geen oorzaken geregistreerd — vul ze in via het detailpaneel</div>');

  // ── Doorlooptijden ────────────────────────────────────────────────────────
  // Per planbordfase: hoe lang staat/stond het werk gemiddeld in die kolom.
  var takenMetWerk = planstore.taken.filter(function (t) { return t.kinderen.length > 0; });
  var faseTot = {}, faseN = {};
  takenMetWerk.forEach(function (t) {
    var tijd = taakStatusTijd(t);
    Object.keys(tijd).forEach(function (k) {
      faseTot[k] = (faseTot[k] || 0) + tijd[k];
      faseN[k] = (faseN[k] || 0) + 1;
    });
  });
  var faseRows = WERKSTATUS.filter(function (st) { return faseTot[st.key]; }).map(function (st) {
    return { label: st.label, sec: faseTot[st.key] / faseN[st.key], hex: st.hex };
  });
  html += reportCard('Doorlooptijd per planbordfase',
    'Gemiddelde tijd die een taak in die kolom staat — over ' + takenMetWerk.length + ' taak/taken met gekoppeld werk',
    faseRows.length ? duurBarList(faseRows)
      : '<div class="agenda-leeg">Nog geen doorlooptijd — koppel meldingen aan een taak en verplaats hem over het planbord</div>');

  // Per taak: totale doorlooptijd, opgesplitst naar fase.
  var taakDuurRows = takenMetWerk.map(function (t) {
    var tijd = taakStatusTijd(t);
    return { label: taakLabel(t), sec: somTijd(tijd), tijd: tijd };
  }).sort(function (a, b) { return b.sec - a.sec; }).slice(0, 12);
  html += reportCard('Doorlooptijd per taak', 'Langstlopend bovenaan; de kleuren laten zien in welke fase de tijd zit',
    taakDuurRows.length ? faseLegendaHtml() + duurBarList(taakDuurRows)
      : '<div class="agenda-leeg">Nog geen taken met gekoppeld werk</div>');

  // Per project: gemiddelde doorlooptijd van de meldingen/oplospunten.
  var projTijd = {}, projAantal = {};
  data.forEach(function (it) {
    var naam = it.project || 'Onbekend project';
    if (!projTijd[naam]) { projTijd[naam] = {}; projAantal[naam] = 0; }
    var tijd = itemStatusTijd(it);
    Object.keys(tijd).forEach(function (k) { projTijd[naam][k] = (projTijd[naam][k] || 0) + tijd[k]; });
    projAantal[naam]++;
  });
  var projDuurRows = Object.keys(projTijd).map(function (naam) {
    var aantal = projAantal[naam] || 1;
    var gemTijd = {};
    Object.keys(projTijd[naam]).forEach(function (k) { gemTijd[k] = projTijd[naam][k] / aantal; });
    return { label: naam + ' (' + aantal + ')', sec: somTijd(gemTijd), tijd: gemTijd };
  }).sort(function (a, b) { return b.sec - a.sec; }).slice(0, 12);
  html += reportCard('Doorlooptijd per project', 'Gemiddeld per melding of oplospunt, gerekend vanaf de aanmaakdatum in de bron — binnen de huidige filters',
    projDuurRows.length ? faseLegendaHtml() + duurBarList(projDuurRows)
      : '<div class="agenda-leeg">Geen items binnen de huidige filters</div>');

  el.innerHTML = html;
}
// Balkenlijst met een duur als waarde. Rijen met een `tijd`-map krijgen een
// gestapelde balk die de verdeling over de planbordfasen toont.
function duurBarList(rows) {
  var max = Math.max.apply(null, rows.map(function (r) { return r.sec; }).concat([1]));
  return rows.map(function (r) {
    var pct = r.sec / max * 100;
    var balk = r.tijd
      ? faseBalkHtml(r.tijd, pct)
      : '<div class="hbar-fill" style="width:' + pct.toFixed(2) + '%;background:' + (r.hex || '#2563eb') + '"></div>';
    return '<div class="hbar-row duur"><div class="hbar-label" title="' + escHtml(r.label) + '">' + escHtml(r.label) + '</div>'
      + '<div class="hbar-track">' + balk + '</div>'
      + '<div class="hbar-num">' + formatDuur(r.sec) + '</div></div>';
  }).join('');
}
function faseLegendaHtml() {
  return '<div class="fase-legenda">' + WERKSTATUS.map(function (st) {
    return '<span><i style="background:' + st.hex + '"></i>' + escHtml(st.label) + '</span>';
  }).join('') + '</div>';
}
function reportCard(title, sub, body, extra) {
  return '<div class="card"><div class="card-header"><div><div class="card-title">' + title + '</div><div class="card-subtitle">' + sub + '</div></div>'
    + (extra ? '<div class="card-extra">' + extra + '</div>' : '')
    + '</div><div class="card-body">' + body + '</div></div>';
}
function hbarList(rows, total) {
  var max = Math.max.apply(null, rows.map(function (r) { return r.n; }).concat([1]));
  var breed = rows.some(function (r) { return r.tekst !== undefined; });
  return rows.map(function (r) {
    return '<div class="hbar-row' + (breed ? ' duur' : '') + '"><div class="hbar-label" title="' + escAttr(r.label) + '">' + escHtml(r.label) + '</div>'
      + '<div class="hbar-track"><div class="hbar-fill" style="width:' + (r.n / max * 100) + '%;background:' + r.hex + '"></div></div>'
      + '<div class="hbar-num">' + escHtml(r.tekst !== undefined ? r.tekst : String(r.n)) + '</div></div>';
  }).join('');
}
// Uren met een Nederlandse komma: 12,5 u
function formatUren(u) {
  if (!u) return '0 u';
  var afgerond = Math.round(u * 10) / 10;
  return String(afgerond).replace('.', ',') + ' u';
}

// ── Tab: Team & instellingen ────────────────────────────────────────────────
function addTeamMember() {
  var input = document.getElementById('team-name-input');
  var name = input.value.trim();
  if (!name) return;
  if (planstore.team.indexOf(name) !== -1) { alert('Deze naam bestaat al.'); return; }
  planstore.team.push(name);
  planstore.team.sort(function (a, b) { return a.localeCompare(b, 'nl'); });
  input.value = '';
  saveStore();
  populateFilters();
  renderAll();
}
function removeTeamMember(name) {
  if (!confirm('Behandelaar "' + name + '" verwijderen? Bestaande toewijzingen blijven staan.')) return;
  planstore.team = planstore.team.filter(function (t) { return t !== name; });
  saveStore();
  populateFilters();
  renderAll();
}
function renderTeam() {
  var el = document.getElementById('team-list');
  if (!el) return;
  var workload = {};
  workItems.forEach(function (it) {
    var plan = getPlan(it.id);
    if (!plan || !plan.behandelaar) return;
    if (plan.werkstatus === 'gereed' || plan.werkstatus === 'gesloten') return;
    workload[plan.behandelaar] = (workload[plan.behandelaar] || 0) + 1;
  });
  el.innerHTML = planstore.team.length
    ? planstore.team.map(function (t) {
        return '<div class="team-row"><span>👤 ' + escHtml(t) + '</span>'
          + '<span class="team-workload">' + (workload[t] || 0) + ' open items</span>'
          + '<button class="team-del" onclick="removeTeamMember(\'' + escAttr(t) + '\')">✕</button></div>';
      }).join('')
    : '<div class="agenda-leeg">Nog geen behandelaars — voeg je team toe om items te kunnen toewijzen.</div>';
  updateStorageInfo();
  syncSettingsInputs();
}
function updateStorageInfo() {
  var el = document.getElementById('storage-info');
  if (!el) return;
  var n = Object.keys(planstore.items).length;
  var kb = Math.round((localStorage.getItem(STORAGE_KEY) || '').length / 1024);
  el.textContent = n + ' items met plandata · ~' + kb + ' kB lokale opslag';
}
function clearPlanData() {
  if (!confirm('Weet je het zeker? Alle werkstatussen, acties en notities worden gewist. Team blijft staan.')) return;
  planstore.items = {};
  saveStore();
  rebuildWorkItems();
}

// ── Export / import plandata ────────────────────────────────────────────────
function exportPlanData() {
  var blob = new Blob([JSON.stringify(planstore, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'so_plandata_' + todayISO() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function importPlanData(raw) {
  if (!raw || typeof raw !== 'object' || !raw.items) { alert('Dit lijkt geen plandata-export te zijn.'); return; }
  var nInc = Object.keys(raw.items).length;
  var nCur = Object.keys(planstore.items).length;
  var nTaken = Array.isArray(raw.taken) ? raw.taken.length : 0;
  var msg = 'Plandata importeren?\nIn bestand: ' + nInc + ' items · huidig: ' + nCur + ' items.';
  if (nTaken) msg += '\n+ ' + nTaken + ' taak/taken worden samengevoegd op ID.';
  msg += '\nBestaande registraties met hetzelfde ID worden overschreven.';
  if (!confirm(msg)) return;
  Object.keys(raw.items).forEach(function (id) { planstore.items[id] = raw.items[id]; });
  (raw.team || []).forEach(function (t) { if (planstore.team.indexOf(t) === -1) planstore.team.push(t); });
  if (Array.isArray(raw.taken)) {
    var byId = {};
    planstore.taken.forEach(function (t) { byId[t.id] = t; });
    raw.taken.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    planstore.taken = Object.keys(byId).map(function (k) { return byId[k]; });
    planstore.taken.forEach(function (t) {
      if (!Array.isArray(t.kinderen)) t.kinderen = [];
      if (!Array.isArray(t.historie)) t.historie = [];
      if (!Array.isArray(t.notities)) t.notities = [];
    });
  }
  planstore.team.sort(function (a, b) { return a.localeCompare(b, 'nl'); });
  migreerOorzaken();
  migreerDoorlooptijd();
  saveStore();
  rebuildWorkItems();
  alert('Plandata geïmporteerd.');
}

// ── Drawer (detailpaneel) ───────────────────────────────────────────────────
function openDrawer(id) {
  drawerId = id;
  document.body.classList.add('drawer-open');
  renderDrawer(id);
}
function closeDrawer() {
  drawerId = null;
  document.body.classList.remove('drawer-open');
}
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('modal-open')) sluitUrenDialoog();
  else if (document.body.classList.contains('weekstart-open')) sluitWeekstart();
  else closeDrawer();
});

function renderDrawer(id) {
  // Taken hebben een eigen drawer-inhoud (basisvelden, kinderen, notities, historie).
  if (id && id.indexOf('tk-') === 0) return renderTaakDrawer(id);

  var it = findItem(id);
  if (!it) { closeDrawer(); return; }
  var plan = ensurePlan(it);
  var now = new Date(); now.setHours(0,0,0,0);

  // Interne projectcode vervangt het bhome-nummer als kop van de melding.
  var titelNummer = bronEffectief(plan, 'projectcodeIntern', it.nummer);
  document.getElementById('drawer-title').textContent = titelNummer || 'Item';
  document.getElementById('drawer-sub').textContent = (it.bron === 'so' ? 'S&O melding' : 'Oplospunt') + ' · ' + (it.project || '');

  var html = '';

  // Broninformatie — bovenaan de handmatig aan te vullen / te overschrijven velden.
  html += '<div class="drawer-section"><div class="drawer-section-title">Broninformatie</div>';
  html += '<dl class="dd-grid bron-grid">';
  html += bronRowInput(id, plan, 'projectcodeIntern', 'Interne projectcode', '', 'bv. eigen projectnummer — vervangt Bhome-nummer bovenaan');
  html += bronRowReadonly('Bhome nummer', it.nummer);
  html += bronRowInput(id, plan, 'klacht', 'Klacht', it.omschrijving, 'omschrijving van de klacht', true);
  html += bronRowReadonly('Project', it.project);
  html += bronRowReadonly('Bedrijf', it.bedrijf);
  html += bronRowInput(id, plan, 'bnr', 'BNR (bouwnummer)', it.bouwnummer, 'bouwnummer');
  html += bronRowInput(id, plan, 'plaats', 'Plaats', '', 'plaats / woonplaats');
  html += bronRowInput(id, plan, 'adres', 'Adres', it.adres, 'straat + huisnummer');
  html += bronRowInput(id, plan, 'telnr', 'Tel.nr', '', 'telefoonnummer bewoner');
  html += bronRowInput(id, plan, 'bwc', 'BWC', '', 'BAM Wood Concepts contact / opzichter');
  html += bronRowReadonly('Aangemaakt', formatDate(it.aangemaakt) + (it.aangemaakt ? ' (' + daysBetween(it.aangemaakt, new Date()) + ' dagen geleden)' : ''));
  html += bronRowReadonly('Fase / type', it.fase);
  html += bronRowReadonly('Categorie', it.categorie);
  html += bronRowReadonly('Ruimte', it.ruimte);
  html += bronRowReadonly('Bronstatus', it.bronStatus + (plan.bronGesloten ? ' — in bron gesloten' : ''));
  if (it.hyperlink && /^https?:\/\//.test(it.hyperlink)) {
    html += '<dt>Bhome</dt><dd><a href="' + escAttr(it.hyperlink) + '" target="_blank" rel="noopener" style="color:var(--accent3)">Open in Bhome ↗</a></dd>';
  }
  html += '</dl></div>';

  // Planning
  html += '<div class="drawer-section"><div class="drawer-section-title">Planning</div><div class="plan-grid">';
  html += planField('Werkstatus', selectHtml(id, 'werkstatus', WERKSTATUS.map(function (s) { return { v: s.key, l: s.label }; }), plan.werkstatus));
  html += planField('Prioriteit', selectHtml(id, 'prio', PRIORITEIT.map(function (p) { return { v: p.key, l: p.label }; }), plan.prio));
  html += planField('Behandelaar', drawerBehandelaarSelect(id, plan.behandelaar));
  html += planField('Geplande datum', '<input type="date" value="' + escAttr(plan.gepland) + '" onchange="setPlanField(\'' + id + '\',\'gepland\',this.value)">');
  html += planField('Geschatte uren', '<input type="number" min="0" step="0.5" value="' + escAttr(plan.uren) + '" placeholder="bv. 4" onchange="setPlanField(\'' + id + '\',\'uren\',this.value)">');
  html += planField('Oorzaak / kostensoort',
    '<select onchange="setPlanField(\'' + id + '\',\'oorzaak\',this.value)">' + oorzaakOptionsHtml(plan.oorzaak) + '</select>');
  html += planField('Oplossing', selectHtml(id, 'oplossing', OPLOSSINGEN.map(function (o) { return { v: o, l: o || '—' }; }), plan.oplossing), true);
  html += planField('Onderdeel van taak', drawerTaakSelectHtml(id), true);
  html += '</div></div>';

  // Doorlooptijd — hoe lang stond dit item in welke fase van het planbord
  var tijdItem = itemStatusTijd(it);
  html += '<div class="drawer-section"><div class="drawer-section-title">Doorlooptijd</div>'
    + '<div class="duur-totaal">Totaal <strong>' + formatDuur(somTijd(tijdItem)) + '</strong>'
    + ' · staat nu <strong>' + formatDuur(secSinds(plan.statusSinds)) + '</strong> op ' + escHtml(stDef(plan.werkstatus).label) + '</div>'
    + faseBalkHtml(tijdItem)
    + faseLijstHtml(tijdItem)
    + '</div>';

  // Acties
  html += '<div class="drawer-section"><div class="drawer-section-title">Acties (' + plan.acties.filter(function (a) { return !a.gereed; }).length + ' open)</div>';
  html += '<div class="actie-list">';
  if (plan.acties.length) {
    plan.acties.forEach(function (a, i) {
      var deadline = a.deadline ? parseDate(a.deadline) : null;
      var teLaat = !a.gereed && deadline && deadline < now;
      html += '<div class="actie-row' + (a.gereed ? ' gereed' : '') + '">'
        + '<input type="checkbox"' + (a.gereed ? ' checked' : '') + ' onchange="toggleActie(\'' + id + '\',' + i + ')">'
        + '<div class="actie-main"><div class="actie-desc">' + escHtml(a.omschrijving) + '</div>'
        + '<div class="actie-meta">'
        + (a.verantwoordelijke ? '<span>👤 ' + escHtml(a.verantwoordelijke) + '</span>' : '')
        + (a.deadline ? '<span class="' + (teLaat ? 'telaat' : '') + '">📅 ' + formatISO(a.deadline) + (teLaat ? ' — te laat' : '') + '</span>' : '')
        + '<span>aangemaakt ' + escHtml(a.aangemaakt || '') + '</span>'
        + (a.gereed && a.gereedOp ? '<span>✓ gereed ' + escHtml(a.gereedOp) + '</span>' : '')
        + '</div></div>'
        + '<button class="actie-del" onclick="deleteActie(\'' + id + '\',' + i + ')">🗑</button></div>';
    });
  } else {
    html += '<div class="agenda-leeg">Nog geen acties uitgezet.</div>';
  }
  html += '</div>';
  html += '<div class="actie-form">'
    + '<input type="text" id="actie-omschrijving" placeholder="Nieuwe actie… (bv. glas bestellen bij leverancier)" onkeydown="if(event.key===\'Enter\')addActie(\'' + id + '\')">'
    + '<select id="actie-verantwoordelijke"><option value="">Verantwoordelijke…</option>'
    + planstore.team.map(function (t) { return '<option value="' + escAttr(t) + '">' + escHtml(t) + '</option>'; }).join('')
    + '</select>'
    + '<input type="date" id="actie-deadline">'
    + '<button class="btn-primary" onclick="addActie(\'' + id + '\')">+ Actie</button>'
    + '</div></div>';

  // Notities
  html += '<div class="drawer-section"><div class="drawer-section-title">Notities</div><div class="note-list">';
  if (plan.notities.length) {
    plan.notities.slice().reverse().forEach(function (n) {
      html += '<div class="note-row"><div class="note-meta">' + escHtml(n.ts) + '</div>' + escHtml(n.tekst) + '</div>';
    });
  } else {
    html += '<div class="agenda-leeg">Nog geen notities.</div>';
  }
  html += '</div><div class="note-form">'
    + '<input type="text" id="note-input" placeholder="Notitie toevoegen… (bv. bewoner gebeld, afspraak volgt)" onkeydown="if(event.key===\'Enter\')addNote(\'' + id + '\')">'
    + '<button class="btn-primary" onclick="addNote(\'' + id + '\')">+ Notitie</button></div></div>';

  // Historie
  html += '<div class="drawer-section"><div class="drawer-section-title">Historie</div><div class="hist-list">';
  html += plan.historie.slice().reverse().map(function (h) {
    return '<div>' + escHtml(h.ts) + ' — ' + escHtml(h.tekst) + '</div>';
  }).join('');
  html += '</div></div>';

  document.getElementById('drawer-body').innerHTML = html;
  saveStore(); // ensurePlan kan een nieuw record hebben aangemaakt
}

// ── Drawer voor taken ───────────────────────────────────────────────────────
// Dezelfde structuur als een melding-drawer, maar velden komen uit de taak
// (planstore.taken) en er is geen bron-JSON. Wél gekoppelde items, notities
// en historie zichtbaar zoals bij een melding.
function renderTaakDrawer(id) {
  var t = findTaak(id);
  if (!t) { closeDrawer(); return; }
  document.getElementById('drawer-title').textContent = taakLabel(t);
  document.getElementById('drawer-sub').textContent = 'Taak · ' + t.kinderen.length + ' gekoppelde item(s)'
    + ' · doorlooptijd ' + formatDuur(somTijd(taakStatusTijd(t)));

  var html = '';

  // Basisinformatie
  html += '<div class="drawer-section"><div class="drawer-section-title">Basisinformatie</div><div class="plan-grid">';
  html += planField('Naam',
    '<input type="text" value="' + escAttr(t.titel) + '" placeholder="Naam van de taak…" onchange="setTaakField(\'' + id + '\',\'titel\',this.value)">');
  html += planField('Projectnummer',
    '<input type="text" value="' + escAttr(t.projectnummer || '') + '" placeholder="bv. 24-0123" onchange="setTaakField(\'' + id + '\',\'projectnummer\',this.value)">');
  html += planField('Omschrijving',
    '<textarea rows="3" placeholder="Omschrijving / doel van de taak…" onchange="setTaakField(\'' + id + '\',\'omschrijving\',this.value)">' + escHtml(t.omschrijving) + '</textarea>', true);
  html += planField('Werkstatus', taakStatusSelect(id, t.status));
  html += planField('Prioriteit', taakPrioSelect(id, t.prio));
  html += planField('Behandelaar', taakBehandelaarSelect(id, t.behandelaar));
  html += planField('Deadline',
    '<input type="date" value="' + escAttr(t.deadline || '') + '" onchange="setTaakField(\'' + id + '\',\'deadline\',this.value)">');
  html += planField('Aangemaakt', '<span style="color:var(--muted);font-size:12.5px">' + escHtml(t.aangemaakt || '—') + '</span>');
  html += '</div>';
  if (t.kinderen.length) {
    html += '<div class="drawer-hint">💡 Wijzigingen aan <strong>werkstatus, prioriteit, behandelaar, deadline of projectnummer</strong> worden automatisch doorgezet naar alle ' + t.kinderen.length + ' gekoppelde item(s). Deadline vult daar het veld <em>Geplande datum</em>, het projectnummer vervangt daar het getoonde nummer.</div>';
  }
  html += '</div>';

  // Doorlooptijd per fase van het planbord
  var tijdTaak = taakStatusTijd(t);
  html += '<div class="drawer-section"><div class="drawer-section-title">Doorlooptijd</div>'
    + '<div class="duur-totaal">Totaal <strong>' + formatDuur(somTijd(tijdTaak)) + '</strong>'
    + ' · staat nu <strong>' + formatDuur(secSinds(t.statusSinds)) + '</strong> op ' + escHtml(stDef(t.status).label)
    + (t.afgerondOp ? ' · afgerond op ' + escHtml(t.afgerondOp) : '') + '</div>'
    + faseBalkHtml(tijdTaak)
    + faseLijstHtml(tijdTaak)
    + '</div>';

  // Gekoppelde meldingen & oplospunten
  // Werkelijke uren per kostenpost
  var urenTot = taakWerkelijkeUrenTotaal(t);
  html += '<div class="drawer-section"><div class="drawer-section-title">Werkelijke uren</div>';
  if (urenTot) {
    html += '<div class="duur-totaal">Totaal <strong>' + formatUren(urenTot) + '</strong>'
      + (t.urenGeregistreerdOp ? ' · vastgelegd ' + escHtml(t.urenGeregistreerdOp) : '') + '</div>'
      + '<div class="oorzaak-chips">' + Object.keys(t.werkelijkeUren).filter(function (k) { return t.werkelijkeUren[k]; }).map(function (k) {
          return '<span class="oorzaak-chip" style="--oz:' + (k ? oorzaakGroepHex(k) : '#94a3b8') + '">'
            + escHtml(urenSleutelLabel(k)) + '<b>' + formatUren(t.werkelijkeUren[k]) + '</b></span>';
        }).join('') + '</div>';
  } else {
    html += '<div class="oorzaak-leeg">Nog niet ingevuld — de module vraagt erom zodra de taak van In uitvoering of Wacht op derden naar Gereed gaat.</div>';
  }
  html += '<button class="mini-btn" style="margin-top:10px" onclick="openUrenDialoog(\'' + id + '\', \'\')">'
    + (urenTot ? '✎ Uren aanpassen' : '+ Uren registreren') + '</button></div>';

  // Oorzaak / kostensoort — meerdere per project mogelijk
  html += '<div class="drawer-section"><div class="drawer-section-title">Oorzaak / kostensoort</div>'
    + taakOorzaakFormHtml(t, 'dw')
    + '<div class="oorzaak-chips">' + taakOorzaakChipsHtml(t) + '</div>'
    + '<div class="oorzaak-uitleg">Wat je hier toevoegt komt op alle gekoppelde meldingen te staan. Hieronder kun je een melding een afwijkende oorzaak geven; die verschijnt dan ook in dit rijtje.</div>'
    + '</div>';

  html += '<div class="drawer-section"><div class="drawer-section-title">Gekoppelde meldingen &amp; oplospunten (' + t.kinderen.length + ')</div>';
  if (t.kinderen.length) {
    html += '<div class="taak-drawer-kinderen">';
    t.kinderen.forEach(function (kid) {
      var kit = findItem(kid);
      if (!kit) {
        html += '<div class="taak-drawer-kind ontbreekt">'
          + '<span>⚠ Item niet geladen (' + escHtml(kid) + ')</span>'
          + '<button class="wv-unlink" title="Ontkoppelen" onclick="ontkoppelItem(\'' + id + '\',\'' + kid + '\')">↩</button>'
          + '</div>';
        return;
      }
      var kplan = getPlan(kit.id);
      var st = stDef(kplan ? kplan.werkstatus : 'nieuw');
      var teLaat = isTeLaat(kit, kplan);
      html += '<div class="taak-drawer-kind' + (teLaat ? ' telaat' : '') + '" onclick="openDrawer(\'' + kit.id + '\')">'
        + (kit.bron === 'so' ? '<span class="badge badge-bron-so">S&amp;O</span>' : '<span class="badge badge-bron-ol">OL</span>')
        + '<span class="taak-drawer-kind-num">' + escHtml(effNummer(kit)) + '</span>'
        + '<span class="taak-drawer-kind-desc">' + escHtml(kit.omschrijving) + '</span>'
        + '<span class="taak-drawer-kind-status">'
        +   '<span class="st-badge" style="color:' + st.hex + '"><span class="st-dot" style="background:' + st.hex + '"></span>' + escHtml(st.label) + '</span>'
        +   (teLaat ? '<span class="kb-late">⚠ te laat</span>' : '')
        + '</span>'
        + '<span class="taak-drawer-kind-acties">'
        +   '<select class="kind-oorzaak" title="Oorzaak van deze melding"'
        +   ' onclick="event.stopPropagation()" onchange="setPlanField(\'' + kit.id + '\',\'oorzaak\',this.value)">'
        +   oorzaakOptionsHtml(kplan ? kplan.oorzaak : '') + '</select>'
        +   '<button class="wv-unlink" title="Ontkoppelen" onclick="event.stopPropagation();ontkoppelItem(\'' + id + '\',\'' + kit.id + '\')">↩</button>'
        + '</span>'
        + '</div>';
    });
    html += '</div>';
  } else {
    html += '<div class="agenda-leeg" style="padding:12px 0">Nog geen items gekoppeld — koppel hieronder een melding of oplospunt.</div>';
  }
  html += '<div class="taak-drawer-koppel">' + taakKoppelSelectHtml(id) + '</div>';
  html += '</div>';

  // Notities
  html += '<div class="drawer-section"><div class="drawer-section-title">Notities</div><div class="note-list">';
  if (t.notities.length) {
    t.notities.slice().reverse().forEach(function (n) {
      html += '<div class="note-row"><div class="note-meta">' + escHtml(n.ts) + '</div>' + escHtml(n.tekst) + '</div>';
    });
  } else {
    html += '<div class="agenda-leeg">Nog geen notities.</div>';
  }
  html += '</div><div class="note-form">'
    + '<input type="text" id="taak-note-input" placeholder="Notitie toevoegen…" onkeydown="if(event.key===\'Enter\')addTaakNote(\'' + id + '\')">'
    + '<button class="btn-primary" onclick="addTaakNote(\'' + id + '\')">+ Notitie</button></div></div>';

  // Historie
  html += '<div class="drawer-section"><div class="drawer-section-title">Historie</div><div class="hist-list">';
  html += t.historie.slice().reverse().map(function (h) {
    return '<div>' + escHtml(h.ts) + ' — ' + escHtml(h.tekst) + '</div>';
  }).join('');
  html += '</div></div>';

  // Verwijderknop onderaan
  html += '<div class="drawer-section" style="margin-top:20px">'
    + '<button class="btn-danger" onclick="verwijderTaak(\'' + id + '\')">🗑 Taak verwijderen</button>'
    + '</div>';

  document.getElementById('drawer-body').innerHTML = html;
}

function addTaakNote(id) {
  var t = findTaak(id); if (!t) return;
  var input = document.getElementById('taak-note-input');
  var tekst = input.value.trim();
  if (!tekst) return;
  t.notities.push({ ts: nowStamp(), tekst: tekst });
  input.value = '';
  saveStore();
  renderAll();
}

function planField(label, control, full) {
  return '<div class="plan-field' + (full ? ' full' : '') + '"><label>' + label + '</label>' + control + '</div>';
}

// Broninfo-rijen. Readonly = bronwaarde uit JSON. Input = bewerkbaar; toont handmatige
// waarde als die gezet is, anders (grijze) bronwaarde als placeholder / prefill.
function bronRowReadonly(label, value) {
  if (value == null || value === '' || value === '—') return '';
  return '<dt>' + escHtml(label) + '</dt><dd>' + escHtml(value) + '</dd>';
}
function bronRowInput(id, plan, field, label, sourceValue, hint, multiline) {
  var override = (plan.bron && plan.bron[field]) || '';
  var effectief = override || sourceValue || '';
  var placeholder = sourceValue
    ? 'bron: ' + sourceValue
    : (hint || 'handmatig invullen');
  var handler = 'setBronField(\'' + id + '\',\'' + field + '\',this.value)';
  var isOverride = override && sourceValue && override !== sourceValue;
  var control;
  if (multiline) {
    control = '<textarea class="bron-input" rows="2" placeholder="' + escAttr(placeholder) + '"'
      + ' onchange="' + handler + '">' + escHtml(effectief) + '</textarea>';
  } else {
    control = '<input class="bron-input" type="text" value="' + escAttr(effectief) + '"'
      + ' placeholder="' + escAttr(placeholder) + '"'
      + ' onchange="' + handler + '">';
  }
  var hintHtml = isOverride
    ? '<div class="bron-hint">handmatig — bron: ' + escHtml(sourceValue) + '</div>'
    : (!sourceValue && !override ? '<div class="bron-hint">geen bronwaarde — handmatig aanvullen</div>' : '');
  return '<dt>' + escHtml(label) + '</dt><dd>' + control + hintHtml + '</dd>';
}
function selectHtml(id, field, options, current) {
  return '<select onchange="setPlanField(\'' + id + '\',\'' + field + '\',this.value)">'
    + options.map(function (o) { return '<option value="' + escAttr(o.v) + '"' + (o.v === current ? ' selected' : '') + '>' + escHtml(o.l) + '</option>'; }).join('')
    + '</select>';
}
function drawerBehandelaarSelect(id, current) {
  var opts = ['<option value=""' + (!current ? ' selected' : '') + '>— niet toegewezen —</option>'];
  planstore.team.forEach(function (t) {
    opts.push('<option value="' + escAttr(t) + '"' + (t === current ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
  if (current && planstore.team.indexOf(current) === -1) opts.push('<option value="' + escAttr(current) + '" selected>' + escHtml(current) + '</option>');
  return '<select onchange="setPlanField(\'' + id + '\',\'behandelaar\',this.value)">' + opts.join('') + '</select>';
}

// Actie-mutaties
function addActie(id) {
  var it = findItem(id); if (!it) return;
  var plan = ensurePlan(it);
  var desc = document.getElementById('actie-omschrijving').value.trim();
  if (!desc) return;
  var verantwoordelijke = document.getElementById('actie-verantwoordelijke').value;
  var deadline = document.getElementById('actie-deadline').value;
  plan.acties.push({ omschrijving: desc, verantwoordelijke: verantwoordelijke, deadline: deadline, gereed: false, aangemaakt: nowStamp(), gereedOp: '' });
  logHist(plan, 'Actie toegevoegd: ' + desc);
  if (plan.werkstatus === 'nieuw') plan.werkstatus = 'beoordeeld';
  saveStore();
  renderAll();
}
function toggleActie(id, idx) {
  var plan = getPlan(id); if (!plan || !plan.acties[idx]) return;
  var a = plan.acties[idx];
  a.gereed = !a.gereed;
  a.gereedOp = a.gereed ? nowStamp() : '';
  logHist(plan, 'Actie ' + (a.gereed ? 'gereed' : 'heropend') + ': ' + a.omschrijving);
  saveStore();
  renderAll();
}
function deleteActie(id, idx) {
  var plan = getPlan(id); if (!plan || !plan.acties[idx]) return;
  if (!confirm('Actie verwijderen?\n"' + plan.acties[idx].omschrijving + '"')) return;
  logHist(plan, 'Actie verwijderd: ' + plan.acties[idx].omschrijving);
  plan.acties.splice(idx, 1);
  saveStore();
  renderAll();
}
function addNote(id) {
  var it = findItem(id); if (!it) return;
  var plan = ensurePlan(it);
  var input = document.getElementById('note-input');
  var tekst = input.value.trim();
  if (!tekst) return;
  plan.notities.push({ ts: nowStamp(), tekst: tekst });
  input.value = '';
  saveStore();
  renderAll();
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
}

// ═══════════════════════════════════════════════════════════════════════════
// TAKEN — generieke taken/werkpakketten
//
// Datamodel per taak:
//   { id, titel, omschrijving, prio, status, behandelaar, deadline,
//     aangemaakt, kinderen: [workItemId,...], historie: [], notities: [] }
//
// Opslag: planstore.taken (gaat mee in export/import van plandata).
// "kinderen" bevat ID's van S&O-meldingen of oplospunten (workItems). Zo
// blijft een taak altijd één-op-veel gekoppeld en overleeft hij het opnieuw
// laden van de bron-JSON's zonder dat er dubbele referenties ontstaan.
// ═══════════════════════════════════════════════════════════════════════════

// Weergavenaam van een taak: projectnummer (als die er is) plus de naam.
function taakLabel(t) {
  if (!t) return '';
  var naam = t.titel || '(zonder naam)';
  return t.projectnummer ? t.projectnummer + ' · ' + naam : naam;
}
function findTaak(id) {
  for (var i = 0; i < planstore.taken.length; i++) if (planstore.taken[i].id === id) return planstore.taken[i];
  return null;
}
function taakVoorItem(itemId) {
  for (var i = 0; i < planstore.taken.length; i++) {
    if (planstore.taken[i].kinderen.indexOf(itemId) !== -1) return planstore.taken[i];
  }
  return null;
}
function logTaakHist(taak, tekst) {
  taak.historie.push({ ts: nowStamp(), tekst: tekst });
  if (taak.historie.length > 100) taak.historie = taak.historie.slice(-100);
}

// Maakt een lege taak en zet hem bovenaan. Slaat zelf niet op — de aanroeper
// bepaalt wanneer er opgeslagen en hertekend wordt.
function maakTaak(titel, histTekst) {
  var taak = {
    id: 'tk-' + hashId('tk|' + Date.now() + '|' + Math.random()),
    titel: titel || '', projectnummer: '', omschrijving: '', prio: 'normaal', status: 'nieuw',
    behandelaar: '', deadline: '', aangemaakt: nowStamp(), afgerondOp: '', oorzaken: [],
    werkelijkeUren: {}, urenGeregistreerdOp: '',
    statusTijd: {}, statusSinds: nowIso(),
    kinderen: [], historie: [{ ts: nowStamp(), tekst: histTekst || 'Taak aangemaakt' }], notities: []
  };
  planstore.taken.unshift(taak);
  return taak;
}

function nieuweTaak() {
  var id = maakTaak('').id;
  takenOpen.add(id);
  saveStore();
  switchTab('werkvoorraad');
  renderAll();
  setTimeout(function () {
    var el = document.querySelector('.wv-taak-row[data-taak-id="' + id + '"] .wv-taak-titel');
    if (el) el.focus();
  }, 40);
}
function verwijderTaak(id) {
  var t = findTaak(id);
  if (!t) return;
  var n = t.kinderen.length;
  var msg = 'Taak "' + taakLabel(t) + '" verwijderen?';
  if (n) msg += '\n' + n + ' gekoppelde item(s) worden losgekoppeld (blijven bestaan in de werkvoorraad).';
  if (!confirm(msg)) return;
  planstore.taken = planstore.taken.filter(function (x) { return x.id !== id; });
  takenOpen.delete(id);
  saveStore();
  renderAll();
}

var TAAK_FIELD_LABELS = { titel: 'Naam', projectnummer: 'Projectnummer', omschrijving: 'Omschrijving', prio: 'Prioriteit', status: 'Status', behandelaar: 'Behandelaar', deadline: 'Deadline' };

// Taak-veld → planveld op de gekoppelde items. Wordt gebruikt om wijzigingen
// aan een taak automatisch door te zetten naar alle onderliggende meldingen /
// oplospunten. Titel en omschrijving zijn taak-specifiek en worden dus NIET
// gepropageerd.
var TAAK_PROPAGATE = { status: 'werkstatus', prio: 'prio', behandelaar: 'behandelaar', deadline: 'gepland' };

// Neem één veld van een taak over op één gekoppeld item.
function propagateVeldNaarKind(taak, kindId, taakField, value) {
  var propField = TAAK_PROPAGATE[taakField];
  if (!propField) return false;
  var kit = findItem(kindId);
  if (!kit) return false;
  var kplan = ensurePlan(kit);
  if (kplan[propField] === value) return false;
  if (propField === 'werkstatus') zetWerkstatus(kplan, value); else kplan[propField] = value;
  var display = value;
  if (propField === 'werkstatus') display = stDef(value).label;
  if (propField === 'prio') display = prioDef(value).label;
  if (propField === 'gepland') display = formatISO(value);
  logHist(kplan, (FIELD_LABELS[propField] || propField) + ' → ' + (display || 'leeg')
    + ' (overgenomen van taak "' + (taak.titel || 'zonder titel') + '")');
  // Zelfde automatische status-verplaatsingen als setPlanField zodat een handmatige
  // wijziging aan een taak dezelfde workflow triggert op de kinderen.
  if (propField === 'gepland' && value && (kplan.werkstatus === 'nieuw' || kplan.werkstatus === 'beoordeeld')) zetWerkstatus(kplan, 'gepland');
  if (propField === 'behandelaar' && value && kplan.werkstatus === 'nieuw') zetWerkstatus(kplan, 'beoordeeld');
  return true;
}

// Gaat een taak van In uitvoering of Wacht op derden naar Gereed, dan moeten
// eerst de werkelijk gemaakte uren per kostenpost worden vastgelegd. De status
// verandert pas als dat is ingevuld (of als je de dialoog annuleert: dan blijft
// alles staan zoals het was).
var VRAAG_UREN_VANUIT = ['uitvoering', 'wachten'];
function setTaakField(id, field, value, urenAlGevraagd) {
  var t = findTaak(id);
  if (!t) return;
  var oud = t[field];
  if (oud === value) return;
  if (!urenAlGevraagd && field === 'status' && value === 'gereed' && VRAAG_UREN_VANUIT.indexOf(oud) !== -1) {
    openUrenDialoog(id, 'gereed');
    return;
  }
  if (field === 'status') {
    // Doorlooptijd van de oude fase afsluiten en de afgerond-datum bijwerken
    boekStatusTijd(t, oud);
    t.status = value;
    var wasAf = oud === 'gereed' || oud === 'gesloten';
    var isAf = value === 'gereed' || value === 'gesloten';
    if (isAf && !wasAf) t.afgerondOp = nowStamp();
    if (!isAf && wasAf) t.afgerondOp = '';
  } else {
    t[field] = value;
  }
  var display = value;
  if (field === 'status') display = stDef(value).label;
  if (field === 'prio') display = prioDef(value).label;
  if (field === 'deadline') display = formatISO(value);
  logTaakHist(t, (TAAK_FIELD_LABELS[field] || field) + ' → ' + (display || 'leeg'));

  // Direct doorzetten naar gekoppelde meldingen / oplospunten
  if (TAAK_PROPAGATE[field] && t.kinderen.length) {
    var n = 0;
    t.kinderen.forEach(function (kid) { if (propagateVeldNaarKind(t, kid, field, value)) n++; });
    if (n) logTaakHist(t, 'Doorgezet op ' + n + ' gekoppelde item(s)');
  }
  // Het projectnummer van de taak is leidend voor alle gekoppelde meldingen:
  // hij overschrijft daar de interne projectcode (en dus het getoonde nummer).
  if (field === 'projectnummer') {
    var m = 0;
    t.kinderen.forEach(function (kid) { if (applyBronField(kid, 'projectcodeIntern', value)) m++; });
    if (m) logTaakHist(t, 'Projectnummer doorgezet op ' + m + ' gekoppelde item(s)');
    populateFilters();
  }

  saveStore();
  renderAll();
}

// Bij het koppelen erft het item meteen de status/prio/behandelaar/deadline van
// de taak — dat is meestal de reden om te koppelen ("dit hoort bij dit werkpakket").
// Alleen overnemen als de taak een BEWUSTE waarde heeft (niet leeg en niet de
// standaardwaarde) — zo overschrijven we bestaande registraties niet met defaults.
var TAAK_DEFAULT_WAARDES = { status: 'nieuw', prio: 'normaal', behandelaar: '', deadline: '' };
function erfTaakVeldenNaarKind(taak, kindId) {
  if (taak.projectnummer) applyBronField(kindId, 'projectcodeIntern', taak.projectnummer);
  Object.keys(TAAK_PROPAGATE).forEach(function (taakField) {
    var val = taak[taakField];
    if (val === undefined || val === null || val === '') return;
    if (TAAK_DEFAULT_WAARDES[taakField] === val) return;
    propagateVeldNaarKind(taak, kindId, taakField, val);
  });
}

function applyKoppelItemAanTaak(taakId, itemId) {
  if (!itemId) return false;
  var t = findTaak(taakId);
  if (!t) return false;
  planstore.taken.forEach(function (other) {
    if (other.id === taakId) return;
    var idx = other.kinderen.indexOf(itemId);
    if (idx !== -1) {
      other.kinderen.splice(idx, 1);
      logTaakHist(other, 'Item ontkoppeld: ' + itemId);
    }
  });
  if (t.kinderen.indexOf(itemId) === -1) {
    t.kinderen.push(itemId);
    logTaakHist(t, 'Item gekoppeld: ' + itemId);
    erfTaakVeldenNaarKind(t, itemId);
  }
  // Gekoppeld = uit het ongebonden blok; een oud vinkje heeft geen doel meer.
  wvSelected.delete(itemId);
  return true;
}
function koppelItemAanTaak(taakId, itemId) {
  if (!applyKoppelItemAanTaak(taakId, itemId)) return;
  saveStore();
  renderAll();
}
function ontkoppelItem(taakId, itemId) {
  var t = findTaak(taakId);
  if (!t) return;
  t.kinderen = t.kinderen.filter(function (x) { return x !== itemId; });
  logTaakHist(t, 'Item ontkoppeld: ' + itemId);
  saveStore();
  renderAll();
}
// Een oorzaak toevoegen aan de taak zet hem meteen op alle gekoppelde meldingen.
// Hebben er al meldingen een andere oorzaak, dan vraagt hij wat je daarmee wilt.
function voegOorzaakToeAanTaak(taakId, waarde) {
  var t = findTaak(taakId);
  if (!t || !waarde) { if (!waarde) alert('Kies eerst een oorzaak of kostensoort.'); return; }
  if (!Array.isArray(t.oorzaken)) t.oorzaken = [];
  if (t.oorzaken.indexOf(waarde) === -1) t.oorzaken.push(waarde);
  var kinderen = t.kinderen.map(findItem).filter(Boolean);
  var anders = kinderen.filter(function (kit) {
    var pl = getPlan(kit.id);
    return pl && pl.oorzaak && pl.oorzaak !== waarde;
  });
  var alleenLege = false;
  if (anders.length) {
    alleenLege = !confirm(anders.length + ' van de ' + kinderen.length + ' meldingen hebben al een andere oorzaak.\n\n'
      + 'OK = allemaal overschrijven met "' + oorzaakLabel(waarde) + '"\n'
      + 'Annuleren = alleen de meldingen zónder oorzaak invullen');
  }
  var n = 0;
  kinderen.forEach(function (kit) {
    var pl = getPlan(kit.id);
    if (alleenLege && pl && pl.oorzaak) return;
    if (applyPlanField(kit.id, 'oorzaak', waarde)) n++;
  });
  logTaakHist(t, 'Oorzaak "' + oorzaakLabel(waarde) + '" toegevoegd' + (n ? ' · doorgezet op ' + n + ' melding(en)' : ''));
  saveStore();
  renderAll();
  if (n) toastMelding('Oorzaak "' + oorzaakLabel(waarde) + '" op ' + n + ' melding(en) gezet');
}
// Alleen van het lijstje van de taak af — de meldingen houden hun registratie.
function verwijderOorzaakVanTaak(taakId, waarde) {
  var t = findTaak(taakId);
  if (!t) return;
  t.oorzaken = (t.oorzaken || []).filter(function (v) { return v !== waarde; });
  logTaakHist(t, 'Oorzaak van de taak gehaald: ' + oorzaakLabel(waarde));
  saveStore();
  renderAll();
}
// Verdeling van de oorzaken over de gekoppelde meldingen.
function taakOorzaakTelling(t) {
  var telling = {}, leeg = 0;
  t.kinderen.forEach(function (kid) {
    var pl = getPlan(kid);
    var v = (pl && pl.oorzaak) || '';
    if (!v) { leeg++; return; }
    telling[v] = (telling[v] || 0) + 1;
  });
  var lijst = (t.oorzaken || []).slice();
  Object.keys(telling).forEach(function (v) { if (lijst.indexOf(v) === -1) lijst.push(v); });
  return { lijst: lijst, telling: telling, leeg: leeg };
}
function taakOorzaakChipsHtml(t) {
  var o = taakOorzaakTelling(t);
  if (!o.lijst.length && !o.leeg) return '<span class="oorzaak-leeg">Nog geen oorzaak gekoppeld</span>';
  var chips = o.lijst.map(function (v) {
    return '<span class="oorzaak-chip" style="--oz:' + oorzaakGroepHex(v) + '"><i></i>'
      + escHtml(oorzaakLabel(v))
      + '<b title="Meldingen met deze oorzaak">' + (o.telling[v] || 0) + '/' + t.kinderen.length + '</b>'
      + '<button title="Van de taak halen — de meldingen houden hun eigen oorzaak"'
      + ' onclick="event.stopPropagation();verwijderOorzaakVanTaak(\'' + t.id + '\',\'' + escAttr(v) + '\')">✕</button>'
      + '</span>';
  }).join('');
  if (o.leeg) chips += '<span class="oorzaak-chip oorzaak-chip-leeg"><i></i>Nog zonder oorzaak<b>' + o.leeg + '</b></span>';
  return chips;
}
function taakOorzaakFormHtml(t, prefix) {
  var selId = prefix + '-oz-' + t.id;
  return '<div class="oorzaak-form">'
    + '<select id="' + selId + '" onclick="event.stopPropagation()">' + oorzaakOptionsHtml('') + '</select>'
    + '<button class="btn-primary" onclick="event.stopPropagation();voegOorzaakToeAanTaak(\'' + t.id + '\', document.getElementById(\'' + selId + '\').value)">+ Toevoegen</button>'
    + '</div>';
}

function toggleTaakOpen(id) {
  if (takenOpen.has(id)) takenOpen.delete(id); else takenOpen.add(id);
  renderAll();
}

function taakBehandelaarSelect(id, current) {
  var opts = ['<option value="">(niet toegewezen)</option>'];
  planstore.team.forEach(function (t) {
    opts.push('<option value="' + escAttr(t) + '"' + (t === current ? ' selected' : '') + '>' + escHtml(t) + '</option>');
  });
  if (current && planstore.team.indexOf(current) === -1) {
    opts.push('<option value="' + escAttr(current) + '" selected>' + escHtml(current) + ' (oud)</option>');
  }
  return '<select onchange="setTaakField(\'' + id + '\',\'behandelaar\',this.value)">' + opts.join('') + '</select>';
}
function taakStatusSelect(id, current) {
  var d = stDef(current);
  var opts = WERKSTATUS.map(function (s) { return '<option value="' + s.key + '"' + (s.key === current ? ' selected' : '') + '>' + s.label + '</option>'; }).join('');
  return '<select style="color:' + d.hex + ';font-weight:600" onchange="setTaakField(\'' + id + '\',\'status\',this.value)">' + opts + '</select>';
}
function taakPrioSelect(id, current) {
  var d = prioDef(current);
  var opts = PRIORITEIT.map(function (p) { return '<option value="' + p.key + '"' + (p.key === current ? ' selected' : '') + '>' + p.label + '</option>'; }).join('');
  return '<select style="color:' + d.hex + ';font-weight:700" onchange="setTaakField(\'' + id + '\',\'prio\',this.value)">' + opts + '</select>';
}

// Dropdown met alle werkitems (voor koppelen). Items die al aan een andere
// taak hangen krijgen een marker zodat verplaatsen bewust gebeurt.
function taakKoppelSelectHtml(taakId) {
  var t = findTaak(taakId);
  var reeds = t ? t.kinderen : [];
  var opts = ['<option value="">— kies een melding of oplospunt om te koppelen —</option>'];
  var lijst = workItems.slice().sort(function (a, b) {
    return (a.project || '').localeCompare(b.project || '', 'nl') || (a.nummer || '').localeCompare(b.nummer || '', 'nl');
  });
  lijst.forEach(function (it) {
    if (reeds.indexOf(it.id) !== -1) return;
    var parent = taakVoorItem(it.id);
    var label = (it.bron === 'so' ? '[S&O] ' : '[OL] ') + (effNummer(it) || '?')
      + ' · ' + (it.project || 'Onbekend')
      + ' — ' + (it.omschrijving || '').slice(0, 60);
    if (parent) label = '↪ ' + label + '  (nu in: ' + taakLabel(parent) + ')';
    opts.push('<option value="' + escAttr(it.id) + '">' + escHtml(label) + '</option>');
  });
  if (opts.length === 1) opts.push('<option value="" disabled>Geen werkitems geladen — laad eerst de bron-JSONs</option>');
  return '<select id="taak-link-' + taakId + '">' + opts.join('') + '</select>'
    + '<button class="btn-primary" onclick="koppelItemAanTaak(\'' + taakId + '\', document.getElementById(\'taak-link-' + taakId + '\').value)">+ Koppel</button>';
}

// Wordt aangeroepen door de drawer om een item aan een andere/geen taak te hangen.
function drawerZetTaakParent(itemId, taakId) {
  if (!itemId) return;
  if (taakId) {
    applyKoppelItemAanTaak(taakId, itemId);
  } else {
    // Ontkoppelen: item gaat terug naar het ongebonden blok in de werkvoorraad
    planstore.taken.forEach(function (t) {
      var idx = t.kinderen.indexOf(itemId);
      if (idx !== -1) { t.kinderen.splice(idx, 1); logTaakHist(t, 'Item ontkoppeld: ' + itemId); }
    });
  }
  saveStore();
  renderAll();
}
function drawerTaakSelectHtml(itemId) {
  var current = taakVoorItem(itemId);
  var opts = ['<option value="">— geen taak —</option>'];
  planstore.taken.forEach(function (t) {
    var label = taakLabel(t) + (t.kinderen.length ? ' — ' + t.kinderen.length + ' items' : '');
    opts.push('<option value="' + escAttr(t.id) + '"' + (current && current.id === t.id ? ' selected' : '') + '>' + escHtml(label) + '</option>');
  });
  return '<select onchange="drawerZetTaakParent(\'' + itemId + '\',this.value)">' + opts.join('') + '</select>'
    + '<button class="btn-primary" style="margin-left:6px" onclick="nieuweTaakVoorItem(\'' + itemId + '\')" title="Maak een nieuwe taak en koppel dit item">+ Nieuw</button>';
}
function nieuweTaakVoorItem(itemId) {
  var it = findItem(itemId);
  var suggestie = it ? ('Werkpakket ' + (it.project || '')).trim() : '';
  var taak = maakTaak(suggestie, 'Taak aangemaakt vanuit melding ' + itemId);
  applyKoppelItemAanTaak(taak.id, itemId);
  takenOpen.add(taak.id);
  saveStore();
  renderAll();
}

// ── Init ────────────────────────────────────────────────────────────────────
loadStore();
syncSettingsInputs();
populateFilters();
renderAll();
