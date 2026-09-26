import express from 'express'
import { db, parseTimeMs as parseFeedMs } from './db.js'
import {
  now, statsSummary, validateItem, ingestPost, addTimeline, openEventCount
} from './pipeline.js'
import {
  JOB_MAX, createJob, getJob, listJobs, resumeJob, pauseJob, recoverInterrupted
} from './import-engine.js'

const app = express()
app.use(express.json({ limit: '5mb' })) // 大批量导入（上限 5000 条）

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 启动恢复：崩溃/重启时未完成的导入任务转「已暂停」，保留进度，等待续跑
const recovered = recoverInterrupted()
if (recovered) console.log(`[PUBMON] 恢复 ${recovered} 个中断的批量导入任务（已暂停，可续跑）`)

// 危机列表（含来源规则、承接规则、未解除预警数、时间线）
function crisisList(withTimeline = false) {
  const list = q(`SELECT c.*, a.title alert_title
    FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id ORDER BY c.id DESC`)
  return list.map((c) => {
    const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at, al.title alert_title, al.level alert_level
      FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
      WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
    // 未解除计数统一口径：与解除/结案/回滚链路共用 openEventCount
    const item = { ...c, rules, open_events: openEventCount(c.id) }
    if (withTimeline) item.timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
    return item
  })
}

// 统一总览统计：预警/解除/危机/结案口径与各列表、回溯页一致（全部基于落库实时计算）
export function monitorOverview() {
  const rules = q1("SELECT COUNT(*) c FROM alerts WHERE active=1").c
  const ruleTotal = q1('SELECT COUNT(*) c FROM alerts').c
  const openEvents = q1("SELECT COUNT(*) c FROM alert_events WHERE status='open'").c
  const resolvedEvents = q1("SELECT COUNT(*) c FROM alert_events WHERE status='resolved'").c
  const closeResolved = q1("SELECT COUNT(*) c FROM alert_events WHERE status='resolved' AND resolve_source='close'").c
  const crisesTotal = q1('SELECT COUNT(*) c FROM crisis').c
  const byStatus = {
    monitoring: q1("SELECT COUNT(*) c FROM crisis WHERE status='monitoring'").c,
    disposal: q1("SELECT COUNT(*) c FROM crisis WHERE status='disposal'").c,
    closed: q1("SELECT COUNT(*) c FROM crisis WHERE status='closed'").c
  }
  const autoCrises = q1("SELECT COUNT(*) c FROM crisis WHERE origin='auto'").c
  const multiRule = q1('SELECT COUNT(*) c FROM (SELECT crisis_id FROM crisis_alerts GROUP BY crisis_id HAVING COUNT(*)>1)').c
  return {
    rules, ruleTotal,
    alertEvents: openEvents + resolvedEvents,
    openEvents, resolvedEvents, closeResolved,
    crisesTotal, crisesByStatus: byStatus, autoCrises, multiRule
  }
}

// ===== 总览 =====
app.get('/api/state', (req, res) => {
  const posts = q('SELECT * FROM posts')
  const hot = q('SELECT * FROM hot_words ORDER BY weight DESC LIMIT 12')
  const activeAlerts = q('SELECT * FROM alerts WHERE active=1')
  const crises = crisisList()
  const sources = q('SELECT s.*, COUNT(p.id) cnt FROM sources s LEFT JOIN posts p ON p.source_id=s.id GROUP BY s.id')
  // 热度趋势（近7时段）
  const nowH = new Date().getHours()
  const trend = []
  for (let i = 6; i >= 0; i--) {
    const seg = nowH - i
    const label = (seg + 24) % 24
    const len = posts.length
    const v = Math.round((len * (0.55 + ((i % 3) * 0.15))) + (Math.sin(i * 1.7) * 6))
    trend.push({ label, value: Math.max(18, v) })
  }
  res.json({
    sources, hotWords: hot, activeAlerts, crises,
    stats: statsSummary(posts),
    overview: monitorOverview(),
    trend
  })
})

// ===== 舆情列表（支持筛选） =====
app.get('/api/posts', (req, res) => {
  const { sentiment, source, topic, q: kw } = req.query
  let sql = 'SELECT * FROM posts WHERE 1=1'
  const args = []
  if (sentiment && sentiment !== 'all') { args.push(sentiment); sql += ` AND sentiment=?` }
  if (source && source !== 'all') { args.push(+source); sql += ` AND source_id=?` }
  if (topic) { args.push(topic); sql += ` AND topic LIKE ?`; args.push(`%${topic}%`) }
  if (kw) { args.push(`%${kw}%`); args.push(`%${kw}%`); sql += ` AND (title LIKE ? OR content LIKE ?)` }
  sql += ' ORDER BY published DESC'
  res.json(q(sql, ...args))
})
app.get('/api/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic FROM posts').all().map((r) => r.topic))
})

// 新增舆情（单条录入，走统一管线，支持可选条目幂等键；响应结构保持不变）
app.post('/api/posts', (req, res) => {
  const err = validateItem(req.body, 0)
  if (err) return res.status(400).json({ error: err })
  const r = ingestPost(req.body, { idemKey: (req.body.idem_key || '').trim() || null })
  if (r.duplicate) {
    const p = q1('SELECT sentiment, heat FROM posts WHERE id=?', r.id)
    return res.json({ ok: true, id: r.id, duplicate: true, sentiment: p?.sentiment, heat: p?.heat, triggered: [] })
  }
  res.json({ ok: true, id: r.id, sentiment: r.sentiment, heat: r.heat, triggered: r.triggered })
})

// ===== 可恢复批量导入任务 =====
function parseFailSeqs(req) {
  // 演练用：请求头 x-sim-fail: "2,5" → 指定条目首轮注入瞬时故障，验证自动重试
  const raw = String(req.headers['x-sim-fail'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}
function parseAlwaysFailSeqs(req) {
  // 演练用：x-sim-fail-always → 每轮都失败（验证条目达到上限 → 任务 failed → 手动重试恢复）
  const raw = String(req.headers['x-sim-fail-always'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}

// 创建导入任务（任务幂等：同 idem_key 重复提交返回同一任务，不重复执行）
app.post('/api/imports', (req, res) => {
  const items = req.body && req.body.items
  const jobKey = typeof req.body?.idem_key === 'string' ? req.body.idem_key.trim() : ''
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > JOB_MAX) return res.status(400).json({ error: `单次最多导入 ${JOB_MAX} 条` })
  // 创建前整批预校验，任一不合格拒绝建任务（尚未写库）
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未创建导入任务', details: errors })

  const { job, createdNow } = createJob({ idemKey: jobKey, items, failSeqs: parseFailSeqs(req), alwaysFailSeqs: parseAlwaysFailSeqs(req) })
  if (!createdNow) {
    return res.status(200).json({ ok: true, reused: true, jobId: job.id, job: getJob(job.id) })
  }
  const started = resumeJob(job.id)
  res.status(202).json({ ok: true, jobId: job.id, status: started.status, job: getJob(job.id) })
})

// 任务列表（最近导入）
app.get('/api/imports', (req, res) => res.json({ jobs: listJobs(20) }))

// 任务详情：进度 + 逐条结果回写
app.get('/api/imports/:id', (req, res) => {
  const detail = getJob(+req.params.id)
  if (!detail) return res.status(404).json({ error: '任务不存在' })
  res.json(detail)
})

// 暂停（状态立即落库，当前块跑完后停在断点）
app.post('/api/imports/:id/pause', (req, res) => {
  const job = pauseJob(+req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 续跑 / 失败重试：pending 继续，failed 条目重置后续跑；幂等键保证不产生重复数据。
// 请求头 x-clear-injection: 1 为演练用——清除持续故障注入，模拟外部依赖恢复后手动重试。
app.post('/api/imports/:id/resume', (req, res) => {
  const job = resumeJob(+req.params.id, { clearInjection: req.headers['x-clear-injection'] === '1' })
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 旧版整批接口（同步语义保留）：内部改为创建可恢复任务并等待结束，任一失败返回 207 + 逐条结果
app.post('/api/posts/batch', async (req, res) => {
  const items = req.body && req.body.items
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > 200) return res.status(400).json({ error: '单次最多导入 200 条' })
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未导入任何数据', details: errors })

  const { job } = createJob({ items, failSeqs: parseFailSeqs(req) })
  resumeJob(job.id)
  let detail
  for (let i = 0; i < 6000; i++) { // 最多等待约 2 分钟
    await new Promise((r) => setTimeout(r, 20))
    detail = getJob(job.id)
    if (['done', 'failed'].includes(detail.job.status)) break
  }
  const results = detail.items.map((it) => it.result || { title: it.payload?.title, error: it.error })
  const fired = results.flatMap((r) => r.triggered || [])
  const body = {
    ok: detail.job.status === 'done',
    jobId: detail.job.id,
    imported: detail.job.total_ok,
    duplicates: detail.job.total_duplicate,
    failed: detail.job.total_failed,
    failures: detail.items.filter((it) => it.status === 'failed').map((it) => ({ seq: it.seq, error: it.error })),
    results,
    summary: {
      alerts: fired.length,
      crisesCreated: fired.filter((t) => t.crisisId && !t.deduped).length,
      crisesMerged: fired.filter((t) => t.deduped).length
    },
    stats: statsSummary()
  }
  res.status(detail.job.status === 'done' ? 200 : 207).json(body)
})

// ===== 热门词 =====
app.post('/api/hotwords', (req, res) => {
  const { word, weight, sentiment = 'neutral' } = req.body
  run('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)', word, weight, sentiment)
  res.json({ ok: true })
})
app.delete('/api/hotwords/:id', (req, res) => {
  run('DELETE FROM hot_words WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ===== 预警 =====
app.get('/api/alerts', (req, res) => {
  res.json({
    alerts: q('SELECT * FROM alerts ORDER BY id DESC'),
    events: q(`SELECT ae.*, p.title pt, p.heat heat, p.sentiment sent, c.title crisis_title
      FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN crisis c ON c.id=ae.crisis_id
      ORDER BY ae.id DESC LIMIT 60`)
  })
})
app.post('/api/alerts', (req, res) => {
  const { title, level, keyword, sentiment, heat_min, merge_topic, merge_window } = req.body
  run('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,1,?,0,?,?)',
    title, level, keyword || '', sentiment || '', heat_min || 0, now(), (merge_topic || '').trim(), Math.max(0, +merge_window || 0))
  res.json({ ok: true })
})
// 编辑规则（时间窗口/归并话题变更即时生效：后续触发按新配置判定，历史触发与时间线原样保留）
app.patch('/api/alerts/:id', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const b = req.body || {}
  const fields = []
  const vals = []
  if (typeof b.title === 'string' && b.title.trim()) { fields.push('title=?'); vals.push(b.title.trim()) }
  if (['red', 'orange', 'yellow'].includes(b.level)) { fields.push('level=?'); vals.push(b.level) }
  if (typeof b.keyword === 'string') { fields.push('keyword=?'); vals.push(b.keyword.trim()) }
  if (typeof b.sentiment === 'string') { fields.push('sentiment=?'); vals.push(b.sentiment.trim()) }
  if (b.heat_min != null && b.heat_min !== '') { fields.push('heat_min=?'); vals.push(Math.max(0, +b.heat_min || 0)) }
  let newTopic, newWindow
  if (typeof b.merge_topic === 'string') { newTopic = b.merge_topic.trim(); fields.push('merge_topic=?'); vals.push(newTopic) }
  if (b.merge_window != null && b.merge_window !== '') { newWindow = Math.max(0, +b.merge_window || 0); fields.push('merge_window=?'); vals.push(newWindow) }
  if (!fields.length) return res.json({ ok: true, changed: [] })
  vals.push(al.id)
  run(`UPDATE alerts SET ${fields.join(',')} WHERE id=?`, ...vals)
  res.json({ ok: true, changed: fields.map((f) => f.replace('=?', '')) })
})
app.post('/api/alerts/:id/toggle', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  run('UPDATE alerts SET active=? WHERE id=?', al.active ? 0 : 1, al.id)
  res.json({ ok: true, active: al.active ? 0 : 1 })
})
app.delete('/api/alerts/:id', (req, res) => {
  // 保留 alert_events 触发记录（危机回溯/历史时间线的一部分），仅解除事件↔规则关联
  run('DELETE FROM crisis_alerts WHERE alert_id=?', req.params.id)
  run('DELETE FROM alerts WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 单条预警解除/撤销解除：幂等（重复解除不重复写时间线），时间线行 ref 关联 alert_event，
// 撤销时精确失效该时间线行（行保留，标记 voided）。
app.post('/api/alert-events/:id/resolve', (req, res) => {
  const ev = q1('SELECT * FROM alert_events WHERE id=?', req.params.id)
  if (!ev) return res.status(404).json({ error: 'not found' })
  const undo = req.body && req.body.undo === true
  const ts = now()

  if (undo) {
    if (ev.status === 'open') return res.json({ ok: true, already: true, status: 'open', crisisId: ev.crisis_id, openLeft: openEventCount(ev.crisis_id) })
    // 结案级联解除的预警不允许单独撤销（须回滚结案），保证结案状态一致
    if (ev.resolve_source === 'close') {
      return res.status(409).json({ error: '该预警随结案级联解除，请先回滚结案' })
    }
    const c = ev.crisis_id ? q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id) : null
    if (c && c.status === 'closed') return res.status(409).json({ error: '事件已结案，请先回滚结案' })
    run("UPDATE alert_events SET status='open', resolved=NULL, resolve_source='manual' WHERE id=?", ev.id)
    if (ev.crisis_id) {
      run("UPDATE crisis_timeline SET voided=1 WHERE ref_type='alert_event' AND ref_id=? AND kind='resolve' AND voided=0", ev.id)
      addTimeline(ev.crisis_id, '解除撤销', `撤销预警 #${ev.id} 的解除，预警重新生效`, { kind: 'resolve', refType: 'alert_event', refId: ev.id, timeStr: ts })
      run('UPDATE crisis SET updated=? WHERE id=?', ts, ev.crisis_id)
    }
    return res.json({ ok: true, status: 'open', crisisId: ev.crisis_id, openLeft: openEventCount(ev.crisis_id) })
  }

  if (ev.status === 'resolved') {
    // 重复解除：幂等返回，不重复写时间线
    return res.json({ ok: true, already: true, status: 'resolved', crisisId: ev.crisis_id, openLeft: openEventCount(ev.crisis_id) })
  }
  const note = (req.body.note || '').trim() || '风险指标回落，预警解除'
  run("UPDATE alert_events SET status='resolved', resolved=?, resolve_source='manual' WHERE id=?", ts, ev.id)
  let timelineId = null
  if (ev.crisis_id) {
    const c = q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id)
    if (c && c.status !== 'closed') {
      const al = q1('SELECT title FROM alerts WHERE id=?', ev.alert_id)
      const noteFull = al ? `规则「${al.title}」：${note}` : note
      timelineId = addTimeline(c.id, '预警解除', noteFull, { kind: 'resolve', refType: 'alert_event', refId: ev.id, timeStr: ts })
      run('UPDATE crisis SET updated=? WHERE id=?', ts, c.id)
    }
  }
  res.json({ ok: true, status: 'resolved', timelineId, crisisId: ev.crisis_id, openLeft: openEventCount(ev.crisis_id) })
})

// 批量解除某规则全部未解除触发（按危机合并写入一条时间线，ref 关联规则，幂等跳过已解除）
app.post('/api/alerts/:id/resolve', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const events = q("SELECT * FROM alert_events WHERE alert_id=? AND status='open'", al.id)
  const note = (req.body.note || '').trim() || '风险指标回落，批量解除'
  const ts = now()
  const byCrisis = {}
  for (const ev of events) {
    run("UPDATE alert_events SET status='resolved', resolved=?, resolve_source='manual' WHERE id=?", ts, ev.id)
    if (ev.crisis_id) (byCrisis[ev.crisis_id] ||= []).push(ev)
  }
  const timelineIds = []
  for (const [cid, evs] of Object.entries(byCrisis)) {
    const c = q1('SELECT * FROM crisis WHERE id=?', cid)
    if (c && c.status !== 'closed') {
      const tlId = addTimeline(c.id, '预警解除', `规则「${al.title}」：${note}（一并解除 ${evs.length} 条触发记录）`,
        { kind: 'resolve', refType: 'alert_rule', refId: al.id, timeStr: ts })
      timelineIds.push(tlId)
      run('UPDATE crisis SET updated=? WHERE id=?', ts, c.id)
    }
  }
  res.json({ ok: true, resolved: events.length, timelineIds })
})

// ===== 危机处置 =====
app.get('/api/crisis', (req, res) => {
  res.json(crisisList(true))
})
app.post('/api/crisis', (req, res) => {
  const { title, level, keyword, topic, plan, analysis, linked_email } = req.body
  const r = run("INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,'manual',?,NULL)",
    title, level || 'orange', 'monitoring', plan || '', analysis || '', now(), now(), linked_email || '', keyword || '', (topic || '').trim())
  const id = Number(r.lastInsertRowid)
  addTimeline(id, '事件建档', '人工建档，初始响应', { kind: 'action' })
  res.json({ ok: true, id })
})
app.post('/api/crisis/:id/status', (req, res) => {
  const { status, action, note } = req.body
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  run('UPDATE crisis SET status=?, updated=? WHERE id=?', status || c.status, now(), c.id)
  addTimeline(c.id, action || '状态更新', note || '', { kind: 'action' })
  res.json({ ok: true })
})
app.post('/api/crisis/:id/timeline', (req, res) => {
  const { action, note } = req.body
  addTimeline(req.params.id, action, note || '', { kind: 'action' })
  run('UPDATE crisis SET updated=? WHERE id=?', now(), req.params.id)
  res.json({ ok: true })
})

// 统一事件时间线：处置时间线条目 + 预警触发/解除状态合并为一条流，按发生时间排序。
// includeVoided=1 时返回含已失效（被回滚撤销）条目，供历史审计；默认隐藏。
app.get('/api/crisis/:id/feed', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const includeVoided = req.query.voided === '1'
  const tl = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id ASC', c.id)
  const evs = q(`SELECT ae.*, al.title alert_title, al.level alert_level, p.title pt, p.heat
    FROM alert_events ae LEFT JOIN alerts al ON al.id=ae.alert_id LEFT JOIN posts p ON p.id=ae.post_id
    WHERE ae.crisis_id=? ORDER BY ae.id ASC`, c.id)
  const feed = []
  for (const t of tl) {
    if (!includeVoided && t.voided) continue
    feed.push({
      source: 'timeline', id: t.id, seq: t.id,
      kind: t.kind, action: t.action, note: t.note, time: t.time,
      tsMs: parseFeedMs(t.time), voided: !!t.voided, refType: t.ref_type, refId: t.ref_id
    })
  }
  for (const e of evs) {
    feed.push({
      source: 'alert_event', id: e.id, seq: 10_000_000 + e.id,
      kind: e.status === 'open' ? 'event_open' : 'event_resolved',
      action: '预警触发', note: e.detail,
      ruleTitle: e.alert_title, level: e.alert_level,
      postTitle: e.pt, heat: e.heat,
      status: e.status, resolved: e.resolved, resolveSource: e.resolve_source,
      time: e.time, tsMs: e.event_at_ms ?? parseFeedMs(e.time), voided: false
    })
  }
  feed.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0) || a.seq - b.seq)
  res.json({ crisisId: c.id, feed })
})

// 回溯：危机档案 + 承接规则 + 关联预警触发记录（按规则拆分）+ 统一口径统计
app.get('/api/crisis/:id/review', (req, res) => {
  const c = q1('SELECT c.*, a.title alert_title FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id WHERE c.id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
  const events = q(`SELECT ae.*, p.title pt, p.heat, p.sentiment sent, a.title alert_title, a.level alert_level
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts a ON a.id=ae.alert_id
    WHERE ae.crisis_id=? ORDER BY ae.id DESC`, c.id)
  const open = openEventCount(c.id)
  // 按规则拆分触发统计（同一事件承接多条规则时分别统计）
  const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at,
      al.title alert_title, al.level alert_level,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id) triggers,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id AND ae.status='open') open
    FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
    WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
  const validTimeline = timeline.filter((t) => !t.voided)
  res.json({
    crisis: c, timeline, events, rules,
    stats: {
      triggers: events.length,
      open,
      resolved: events.length - open,
      closeResolved: events.filter((e) => e.status === 'resolved' && e.resolve_source === 'close').length,
      rules: rules.length,
      posts: new Set(events.map((e) => e.post_id).filter((x) => x != null)).size,
      actions: validTimeline.filter((t) => t.kind === 'action').length,
      firstAt: events.length ? events[events.length - 1].time : null,
      lastAt: events.length ? events[0].time : null
    }
  })
})

// 结案：写入回溯总结，级联解除关联的未解除预警（标记 resolve_source='close'），完成闭环。
// 时间线结案行 ref_type='close'，回滚时据此精确失效。
app.post('/api/crisis/:id/close', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status === 'closed') return res.json({ ok: true, already: true })
  const summary = (req.body.summary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const ts = now()
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", c.id)
  for (const ev of opens) run("UPDATE alert_events SET status='resolved', resolved=?, resolve_source='close' WHERE id=?", ts, ev.id)
  run("UPDATE crisis SET status='closed', prev_status=?, closed_at=?, updated=? WHERE id=?", c.status, ts, ts, c.id)
  // 结案级联解除可能横跨多条规则，记录涉及的规则名
  const auto = opens.length
    ? `（同步解除 ${opens.length} 条未解除预警：${[...new Set(opens.map((e) => e.alert_id))].map((rid) => {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid); return al ? `「${al.title}」` : '已删除规则'
      }).join('、')}）`
    : ''
  const timelineId = addTimeline(c.id, '事件结案', summary + auto, { kind: 'close', refType: 'close', refId: null, timeStr: ts })
  run('UPDATE crisis_timeline SET ref_id=? WHERE id=?', timelineId, timelineId)
  res.json({ ok: true, resolved: opens.length, timelineId, openLeft: 0 })
})

// 结案回滚：恢复结案前状态，仅重开「随本次结案级联解除」的预警（手动解除的不动），
// 失效对应的结案/解除时间线行（保留历史），追加「结案回滚」记录。支持反复结案/回滚。
app.post('/api/crisis/:id/reopen', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status !== 'closed') return res.status(409).json({ error: '事件未结案，无需回滚' })
  const ts = now()
  // 最近一次有效结案行（同一事件可能经历多轮结案/回滚）
  const closeRow = q1("SELECT * FROM crisis_timeline WHERE crisis_id=? AND kind='close' AND voided=0 ORDER BY id DESC LIMIT 1", c.id)
  const reopened = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='resolved' AND resolve_source='close'", c.id)
  for (const ev of reopened) {
    run("UPDATE alert_events SET status='open', resolved=NULL, resolve_source='manual' WHERE id=?", ev.id)
  }
  // 失效结案行及其期间的解除行（仅失效本轮结案之后、未被手动撤销的行）
  if (closeRow) {
    run('UPDATE crisis_timeline SET voided=1 WHERE id=?', closeRow.id)
    run("UPDATE crisis_timeline SET voided=1 WHERE crisis_id=? AND kind='resolve' AND voided=0 AND id>?", c.id, closeRow.id)
  }
  const restoreStatus = c.prev_status || (openEventCount(c.id) > 0 ? 'disposal' : 'monitoring')
  run("UPDATE crisis SET status=?, closed_at=NULL, updated=? WHERE id=?", restoreStatus, ts, c.id)
  addTimeline(c.id, '结案回滚',
    (req.body.note || '').trim() || `回滚结案，恢复为「${restoreStatus === 'disposal' ? '处置中' : '监测中'}」，重开 ${reopened.length} 条随结案解除的预警`,
    { kind: 'reopen', refType: 'close', refId: closeRow ? closeRow.id : null, timeStr: ts })
  res.json({ ok: true, restoredStatus: restoreStatus, reopened: reopened.length, openLeft: openEventCount(c.id) })
})
app.delete('/api/crisis/:id', (req, res) => {
  run('DELETE FROM crisis_alerts WHERE crisis_id=?', req.params.id)
  run('UPDATE alert_events SET crisis_id=NULL WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis_timeline WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis WHERE id=?', req.params.id)
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT) || 4130
app.listen(PORT, () => console.log(`[PUBMON] API running at http://localhost:${PORT}`))
