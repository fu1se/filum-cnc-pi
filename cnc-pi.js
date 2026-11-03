// @plugin      cnc-pi
// @name        ЧПУ (cnc-pi)
// @version     1.0
// @author      fu1se
// @homepage    https://github.com/fu1se/filum-cnc-pi
// @description Фрезерный станок на GRBL через cncd (github.com/fu1se/cnc-pi) как ещё один «принтер»: добавьте его в списке принтеров с типом «ЧПУ (cnc-pi)». Статус, прогресс, пауза и стоп, джог, Home, файлы и консоль работают через обычный интерфейс Filum; разблокировка, сброс и обнуление — на вкладке «Управление». github.com/fu1se/filum-cnc-pi
// @grant       http
// @grant       device

// ---------- состояние ----------
let addr = ''          // «192.168.0.50:8080» — адрес cncd
let token = ''         // CNC_TOKEN (адрес можно указать как «ip:8080?token=…»)
let active = false     // ЧПУ выбрано в приложении
let st = null          // state из cncd
let job = null         // job из cncd
let online = false
let lastError = ''
let failures = 0
let skip = 0
let camera = null
let feed = filum.storage.get('feed', 1000)   // подача джога, мм/мин (у станка свой предел $110…)
let section = null

const STATES = { Idle: 'Простой', Run: 'Работа', Hold: 'Пауза', Jog: 'Джог', Alarm: 'АВАРИЯ', Door: 'Дверь открыта',
  Check: 'Проверка G-кода', Home: 'Поиск нуля', Sleep: 'Сон' }

// ---------- HTTP к cncd ----------
function url(path) {
  const q = token ? (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token) : ''
  return 'http://' + addr + path + q
}

/** Запрос к cncd; при ошибке — null, текст ошибки в lastError и в консоли приложения. */
function api(method, path, body, quiet) {
  try {
    const r = method === 'GET' ? filum.http.get(url(path)) : filum.http.post(url(path), body || {})
    if (r.status === 401) throw new Error('cncd требует токен: укажите адрес как ip:порт?token=…')
    if (r.status === 404 && path === '/api/status') throw new Error('обновите cncd: нет GET /api/status')
    const d = JSON.parse(r.body)
    if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status))
    online = true; failures = 0; lastError = ''
    return d
  } catch (e) {
    lastError = String(e.message || e)
    if (path === '/api/status') { online = false; failures++ }
    if (!quiet) { filum.device.log('!', 'ЧПУ: ' + lastError); filum.ui.toast('ЧПУ: ' + lastError) }
    return null
  }
}
const post = (path, body) => api('POST', path, body)

// ---------- опрос и состояние для приложения ----------
function grblState() { return st ? (st.state || '').split(':')[0] : '' }
const jobActive = () => !!(job && job.name && (job.running || job.paused))

function poll() {
  if (!active) return
  const d = api('GET', '/api/status', null, true)
  if (d) { st = d.s; job = d.job }
  publish()
}

function publish() {
  if (!active) return
  const g = grblState()
  let state = 'standby'
  if (g === 'Alarm') state = 'error'
  else if (g === 'Hold' || (job && job.paused)) state = 'paused'
  else if (jobActive()) state = 'printing'

  const s = { connected: online, state: state, name: 'cncd' }
  if (!online) {
    s.message = 'Нет связи с cncd (' + addr + ')' + (lastError ? ': ' + lastError : '')
  } else if (st) {
    s.status = (STATES[g] || g || '—') + (st.connected ? '' : ' · станок не подключён к Pi')
    if (st.message) s.message = st.message
    s.position = st.wpos
    s.homed = 'xyz'
    if (job && job.name) {
      s.file = job.name
      if (job.total) s.progress = Math.floor(job.done * 100 / job.total)
      s.printTime = Math.round(job.elapsed || 0)
      if (job.done > 0 && job.total > job.done) s.timeLeft = Math.round(job.elapsed * (job.total - job.done) / job.done)
    }
  }
  if (camera) s.camera = camera
  filum.device.update(s)
  showSection()
}

filum.every(1000, () => {
  if (!active) return
  // недоступен — опрашиваем реже, чтобы не держать поток плагинов на таймаутах
  if (skip > 0) { skip--; return }
  poll()
  if (failures > 0) skip = Math.min(10, failures * 2)
})

// ---------- то, чего нет у принтера: вкладка «Управление» ----------
const items = () => [
  { type: 'text', text: online && st
      ? 'Станок: ' + (STATES[grblState()] || grblState()) + (st.ov ? ' · оверрайды ' + st.ov.join('/') + '%' : '')
      : 'Нет связи с cncd' },
  { type: 'button', label: 'Разблок. $X', onClick: () => { command('$X'); poll() } },
  { type: 'button', label: '⛔ Сброс', onClick: () => { post('/api/realtime', { name: 'reset' }); poll() } },
  { type: 'text', text: 'Сброс останавливает станок мгновенно, но позиция теряется: потом $X и Home.' },
  { type: 'text', text: 'Обнулить рабочие координаты:' },
  { type: 'button', label: 'Ноль XY', onClick: () => { post('/api/zero', { axes: ['X', 'Y'] }); poll() } },
  { type: 'button', label: 'Ноль Z', onClick: () => { post('/api/zero', { axes: ['Z'] }); poll() } },
  { type: 'button', label: 'Ноль XYZ', onClick: () => { post('/api/zero', { axes: ['X', 'Y', 'Z'] }); poll() } },
  { type: 'slider', label: 'Подача джога, мм/мин', min: 100, max: 3000, step: 100, value: feed,
    onChange: v => { feed = Math.round(v); filum.storage.set('feed', feed); showSection() } },
]

function showSection() {
  if (!active) return
  if (section === null) section = filum.ui.section('ЧПУ', items())
  else filum.ui.update(section, items())
}

function hideSection() {
  if (section !== null) { filum.ui.remove(section); section = null }
}

function command(script) {
  // несколько строк из консоли — по одной; комментарии GRBL не нужны
  String(script).split('\n').map(l => l.trim()).filter(l => l).forEach(l => post('/api/command', { line: l }))
}

// ---------- драйвер ----------
filum.device.register({
  name: 'ЧПУ (cnc-pi)',
  addressHint: '192.168.0.50:8080',

  connect(address) {
    const a = String(address).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    const q = a.indexOf('?token=')
    addr = q >= 0 ? a.slice(0, q) : a
    token = q >= 0 ? decodeURIComponent(a.slice(q + 7)) : ''
    active = true; online = false; st = null; job = null; failures = 0; skip = 0; camera = null
    filum.device.log('!', 'ЧПУ: подключение к cncd ' + addr)
    poll()
    const cam = online ? api('GET', '/api/camera', null, true) : null
    if (cam && cam.available) camera = url('/camera/stream')
    publish()
  },

  disconnect() {
    active = false
    hideSection()
  },

  command: script => { command(script); poll() },

  jog(axis, distance, appFeed) {
    const a = {}
    a[String(axis).toUpperCase()] = distance
    // приложение шлёт подачу принтера (6000 мм/мин) — для фрезера берём свою
    post('/api/jog', { axes: a, feed: Math.min(appFeed, feed) })
    poll()
  },

  home: () => { command('$H'); poll() },

  pause() {
    poll()   // решение — по свежему состоянию станка, а не по прошлому опросу
    if (jobActive() && !job.paused) post('/api/job', { action: 'pause' })
    else post('/api/realtime', { name: 'hold' })
    poll()
  },

  resume() {
    poll()   // решение — по свежему состоянию станка, а не по прошлому опросу
    if (job && job.paused) post('/api/job', { action: 'resume' })
    else post('/api/realtime', { name: 'resume' })
    poll()
  },

  stop() {
    poll()   // решение — по свежему состоянию станка, а не по прошлому опросу
    if (jobActive()) post('/api/job', { action: 'stop' })
    else post('/api/realtime', { name: 'reset' })
    poll()
  },

  files() {
    const d = api('GET', '/api/files')
    return d ? d.files.map(f => ({ path: f.name, size: f.size, modified: f.mtime })) : null
  },

  start(path) {
    poll()   // решение — по свежему состоянию станка, а не по прошлому опросу
    const g = grblState()
    if (g && g !== 'Idle') { filum.ui.toast('Станок не в простое: ' + (STATES[g] || g)); return }
    post('/api/job', { action: 'start', name: path })
    filum.log('задание запущено: ' + path)
    poll()
  },
})
