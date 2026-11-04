// @plugin      cnc-pi
// @name        ЧПУ (cnc-pi)
// @version     1.5
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
let statusApi = true   // старый cncd без GET /api/status: управляем, но без координат и статуса
let lastError = ''
let failures = 0
let skip = 0
let camera = null
let cameraTicks = 0    // камера не найдена — перепроверяем раз в ~30 с
let feed = filum.storage.get('feed', 1000)   // подача джога, мм/мин (у станка свой предел $110…)
// после Home ($H) станок отъезжает от точки парковки на смещение {X, Y, Z} и ставит там рабочий ноль XYZ
// (zeroAfterHome = false — оставить рабочие координаты как были и не отъезжать)
let homeOffset = loadOffset()
let zeroAfterHome = filum.storage.get('zeroAfterHome', true)
let section = null
const API2 = filum.version >= 2   // Filum 0.2.3+: три поля, неактивные кнопки, подтверждение сброса

function loadOffset() {
  const o = filum.storage.get('homeOffset3', null) || filum.storage.get('homeOffset2', {}) || {}
  return { X: +o.X || 0, Y: +o.Y || 0, Z: +o.Z || 0 }
}

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
    if (r.status === 404 && path === '/api/status') { statusApi = false; return null }
    const d = JSON.parse(r.body)
    if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status))
    online = true; failures = 0; lastError = ''
    return d
  } catch (e) {
    lastError = String(e.message || e)
    if (path === '/api/status' || (!statusApi && path === '/api/files')) { online = false; failures++ }
    if (!quiet) { filum.device.log('!', 'ЧПУ: ' + lastError); filum.ui.toast('ЧПУ: ' + lastError) }
    return null
  }
}
const post = (path, body) => api('POST', path, body)

/** /api/camera отвечает без поля ok ({available, device…}) — проверяем отдельно от api(). */
function checkCamera() {
  try {
    const r = filum.http.get(url('/api/camera'))
    const d = r.status === 200 ? JSON.parse(r.body) : null
    camera = d && d.available ? url('/camera/stream') : null
  } catch (e) {
    camera = null
  }
}

// ---------- опрос и состояние для приложения ----------
function grblState() { return st ? (st.state || '').split(':')[0] : '' }
const jobActive = () => !!(job && job.name && (job.running || job.paused))

function poll() {
  if (!active) return
  if (statusApi) {
    const d = api('GET', '/api/status', null, true)
    if (d) { st = d.s; job = d.job }
  }
  // старый cncd: связь проверяем по списку файлов, состояние станка неизвестно
  if (!statusApi) api('GET', '/api/files', null, true)
  if (online && !camera && ++cameraTicks >= 30) { cameraTicks = 0; checkCamera() }
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
    s.message = 'cncd ' + addr + ' не отвечает' + (lastError && !/failed to connect|timeout|refused/i.test(lastError) ? ': ' + lastError : '')
  } else if (!statusApi) {
    s.status = 'На связи · без координат: обновите cncd (нужен GET /api/status)'
    s.homed = 'xyz'
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
function statusLine() {
  if (!online) return 'Нет связи с cncd'
  if (!statusApi) return 'Состояние станка недоступно: обновите cncd на Pi (нужен GET /api/status). Управление работает.'
  if (!st) return 'Жду состояние…'
  return 'Станок: ' + (STATES[grblState()] || grblState()) + (st.ov ? ' · оверрайды ' + st.ov.join('/') + '%' : '')
}

function items() {
  const on = online
  const idle = on && !jobActive()          // во время задания ноль и смещение не трогаем
  const zero = axes => () => { post('/api/zero', { axes: axes }); poll() }
  const list = [
    { type: 'text', text: statusLine() },
    { type: 'text', text: 'Рабочий ноль здесь', style: 'label' },
    { type: 'button', label: 'Ноль XY', enabled: idle, onClick: zero(['X', 'Y']) },
    { type: 'button', label: 'Ноль Z', enabled: idle, onClick: zero(['Z']) },
    { type: 'button', label: 'Ноль XYZ', enabled: idle, onClick: zero(['X', 'Y', 'Z']) },
    { type: 'slider', label: 'Подача джога, мм/мин', min: 100, max: 3000, step: 100, value: feed,
      onChange: v => { feed = Math.round(v); filum.storage.set('feed', feed); showSection() } },
    { type: 'text', text: 'После Home', style: 'label' },
    { type: 'switch', label: 'Отъехать на смещение и обнулить XYZ', value: zeroAfterHome, enabled: idle || !on,
      onChange: v => { zeroAfterHome = !!v; filum.storage.set('zeroAfterHome', zeroAfterHome); showSection() } },
  ]
  if (API2) {
    list.push({ type: 'fields', numeric: true, button: 'Сохранить смещение', enabled: zeroAfterHome,
      fields: AXES.map(a => ({ label: a + ', мм', value: fmtNum(homeOffset[a]) })),
      onSubmit: v => saveOffset(v) })
  } else {
    list.push({ type: 'input', label: 'Смещение X Y Z, мм', button: 'Сохранить', value: AXES.map(a => fmtNum(homeOffset[a])).join(' '),
      onSubmit: v => saveOffset(String(v).trim().split(/[\s;]+/)) })
  }
  list.push({ type: 'text', style: 'hint', text: offsetText() })
  list.push({ type: 'text', text: 'Авария и сброс', style: 'label' })
  list.push({ type: 'button', label: 'Разблок. $X', enabled: on, onClick: () => { command('$X'); poll() } })
  list.push({ type: 'button', label: 'Сброс', enabled: on, style: 'danger',
    confirm: 'Станок остановится мгновенно, задание прервётся, позиция потеряется — потом нужны $X и Home.',
    onClick: () => { post('/api/realtime', { name: 'reset' }); poll() } })
  // старое приложение без подтверждения — хотя бы предупреждение рядом
  if (!API2) list.push({ type: 'text', text: 'Сброс останавливает станок мгновенно, но позиция теряется: потом $X и Home.' })
  return list
}

function saveOffset(values) {
  const nums = AXES.map((a, i) => {
    const t = String(values[i] === undefined ? '' : values[i]).trim().replace(',', '.')
    return t === '' ? 0 : Number(t)
  })
  if (nums.some(n => isNaN(n))) return filum.ui.toast('Смещение: нужны числа, например 2, 3, -0.5')
  homeOffset = { X: nums[0], Y: nums[1], Z: nums[2] }
  filum.storage.set('homeOffset3', homeOffset)
  filum.ui.toast('После Home: ' + (hasOffset() ? 'отъезд на ' + offsetStr() + ' и ' : '') + 'ноль XYZ')
  showSection()
}

function showSection() {
  if (!active) return
  if (section === null) section = filum.ui.section('ЧПУ', items())
  else filum.ui.update(section, items())
}

function hideSection() {
  if (section !== null) { filum.ui.remove(section); section = null }
}

const fmtNum = v => String(Math.round(v * 1000) / 1000)

const AXES = ['X', 'Y', 'Z']
const hasOffset = () => AXES.some(a => homeOffset[a] !== 0)
const offsetStr = () => AXES.filter(a => homeOffset[a] !== 0).map(a => a + fmtNum(homeOffset[a])).join(' ')

/**
 * Команды после $H: отъезд от точки парковки на смещение (G91 G0) и рабочий ноль XYZ там (G10 L20 P0).
 * Z вверх (+) — сначала Z, потом XY; Z вниз (−) — сначала XY, потом Z: фреза не идёт низом над деталью.
 */
function homeOffsetGcode() {
  if (!zeroAfterHome) return []
  const xy = ['X', 'Y'].filter(a => homeOffset[a]).map(a => a + fmtNum(homeOffset[a])).join(' ')
  const z = homeOffset.Z ? 'Z' + fmtNum(homeOffset.Z) : ''
  const out = []
  // G91 в той же строке: относительный отъезд не зависит от того, что было модальным до Home
  if (z && homeOffset.Z > 0) out.push('G91 G0 ' + z)
  if (xy) out.push('G91 G0 ' + xy)
  if (z && homeOffset.Z < 0) out.push('G91 G0 ' + z)
  if (xy || z) out.push('G90')
  out.push('G10 L20 P0 X0 Y0 Z0')
  return out
}

const offsetText = () => !zeroAfterHome
  ? 'После Home рабочие координаты не меняются.'
  : hasOffset() ? 'После Home из приложения: отъезд на ' + offsetStr() + ' от точки парковки, там X0 Y0 Z0.'
  : 'После Home из приложения: X0 Y0 Z0 в точке парковки.'

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
    active = true; online = false; statusApi = true; st = null; job = null; failures = 0; skip = 0; camera = null; cameraTicks = 0
    filum.device.log('!', 'ЧПУ: подключение к cncd ' + addr)
    poll()
    if (online) checkCamera()
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

  home() {
    command('$H')
    // cncd ставит команды в очередь станка по порядку: отъезд и ноль выполнятся после окончания хоминга
    const after = homeOffsetGcode()
    if (after.length) { command(after.join('\n')); filum.device.log('>', 'после Home: ' + after.join(' · ')) }
    poll()
  },

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
    else if (!statusApi) { if (!api('POST', '/api/job', { action: 'stop' }, true)) post('/api/realtime', { name: 'reset' }) }
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
