// CONFIGURACIÓN (app.config.json) — explicación línea por línea + rangos sugeridos
// =================================================================================================
//
// "llm": {                                    // controla intervención del LLM (no afecta el vector search base)
//   "enabled": true,                          // true = permite reescritura con LLaMA; false = nunca reescribe (menor latencia)
//   "url": "http://127.0.0.1:8081/completion",// endpoint del servidor LLaMA/llama.cpp/ollama compatible
//   "timeout_ms": 3000,                       // tope de espera para llamadas largas al LLM (reescritura final)
//   "mark": " ✨LLM",                          // marca que el front muestra como chip “LLM”
//   "min_chars": 1000,                        // largo mínimo del artículo para habilitar reescritura
//   "min_score_to_use": 0.60                  // score del top hit necesario para permitir reescritura
// },
//
// "perf": {
//   "ask_budget_ms": 3500,                    // presupuesto total del endpoint /ask
//   "embed_timeout_ms": 1800,                 // timeout por request al servicio de embeddings
//   "llm_step_max_ms": 600,                   // tope para pasos LLM “cortos” (rewrite/rerank/summary)
//   "rerank_max_candidates": 3                // candidatos máximos enviados al rerank en paralelo
// },
//
// "server": { "port": 3000 },
//
// "db": {
//   "host": "localhost",
//   "user": "museo",
//   "password": "museo2025",
//   "database": "museo"
// },
//
// "embed": {
//   "url": "http://127.0.0.1:5001/embed",
//   "timeout_ms": 15000
// },
//
// "search": {
//   "top_k": 4,
//   "sim_threshold": 0.16,
//   "min_best_score": 0.70,
//   "snippet_chars": 2000,
//   "tag_match_bonus": 0.04,
//   "overlap_bonus_per_token": 0.00,
//   "overlap_bonus_max": 0.00,
//   "default_context": "Realicó",
//   "tag_bypass_sim": 0.70,
//
//   "rerank_with_llm": true,
//   "rerank_top_k": 6,
//   "rerank_min_chars": 400,
//   "llm_query_expand": true,
//   "llm_query_rewrite_on_low_conf": true
// },
//
// "disambiguation": {
//   "choice_delta": 0.02,
//   "gate_by_domain": true,
//   "generic_single_word_policy": "refine"
// },
//
// "domain": {
//   "name": "museo_realico",
//   "hints": ["realic","fundac","biblioteca","escuela","epet","museo","molino","cooperativa","banco","polic","bombero","parque","centro cultural","ordenanza","mapa","plano","estación","tecno","histori","casona","juzgado","iglesia"],
//   "wh_prefixes": ["cuando","cuándo","donde","dónde","que","qué","quien","quién","cual","cuál","como","cómo"],
//   "min_words_for_choices": 2,
//   "allow_year_as_signal": true,
//   "refine_message": "La consulta “{q}” es amplia para esta base. Indicá una pista (institución, año o lugar) para acercar el resultado."
// },
//
// "ranking": { "weights": { "prefer": 0.10, "avoid": 0.10 } },
// "terms":   { "prefer_terms": [], "avoid_terms": [] },
//
// "intents": [
//   {
//     "name": "fecha_fundacion",
//     "detect": "(cuando|fecha).*(fundaci[oó]n|fundad[oa]|fundo)|(fundaci[oó]n|fundad[oa]|fundo).*(cuando|fecha)",
//     "prefer_terms": ["fundacion","fundada","fundado","se fundó","acta fundacional","fundacional"],
//     "avoid_terms": [],
//     "prompt": "short_date"
//   }
// ]
// =================================================================================================

import 'dotenv/config'
import express from 'express'
import path from 'path'
import mysql from 'mysql2/promise'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { performance } from 'perf_hooks'

// Polyfill fetch (Node < 18)
if (typeof fetch === 'undefined') {
  const { default: nodeFetch } = await import('node-fetch')
  // @ts-ignore
  global.fetch = nodeFetch
}

// Rutas absolutas (ESM)
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// Util: lectura segura de JSON local
const readJson = (name, fallback = {}) => {
  try {
    const full = path.join(__dirname, name)
    const raw  = fs.readFileSync(full, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

// Configuración principal
const APP    = readJson('app.config.json', {})
const SCHEMA = readJson('schema.map.json', {})

const TCONF  = SCHEMA?.tables?.conocimiento      ?? {}
const FBCONF = SCHEMA?.tables?.retroalimentacion ?? {}

const PORT        = Number(process.env.PORT       ?? APP?.server?.port ?? 3000)
const EMBED_URL   =        process.env.EMBED_URL  ?? APP?.embed?.url   ?? 'http://127.0.0.1:5001/embed'

// Timeouts / perf
const EMBED_TMOUT_GLOBAL = Number(APP?.embed?.timeout_ms ?? 15000)
const PERF_BUDGET_MS     = Number(APP?.perf?.ask_budget_ms ?? 3500)
const PERF_EMBED_TMOUT   = Number(APP?.perf?.embed_timeout_ms ?? 1800)
const LLM_STEP_MAX_MS    = Number(APP?.perf?.llm_step_max_ms ?? 600)
const RERANK_MAX_CAND    = Math.max(1, Number(APP?.perf?.rerank_max_candidates ?? 3))
// Presupuesto específico para “summary” (puede venir en app.config.json)
const SUMMARY_STEP_MAX_MS = Number(APP?.perf?.summary_step_max_ms ?? (LLM_STEP_MAX_MS * 2))

// LLM thresholds
const LLM_SUMMARIZE_MIN_CHARS = Number(APP?.llm?.summarize_min_chars ?? APP?.llm?.min_chars ?? 500)
const LLM_MIN_CHARS           = LLM_SUMMARIZE_MIN_CHARS
const LLM_MIN_SCORE           = Number(APP?.llm?.min_score_to_use ?? 0)

// Búsqueda / ranking
const TOP_K         = Number(APP?.search?.top_k          ?? 4)
const SIM_THRESHOLD = Number(APP?.search?.sim_threshold  ?? 0.16)
const MIN_BEST      = Number(APP?.search?.min_best_score ?? 0.70)
const SNIPPET_CHARS = Number(APP?.search?.snippet_chars  ?? 1500)
const CHOICE_DELTA  = Number(APP?.disambiguation?.choice_delta ?? 0.02)
const RERANK_ENABLED           = Boolean(APP?.search?.rerank_with_llm ?? false)
const RERANK_TOPK              = Number(APP?.search?.rerank_top_k ?? Math.min(TOP_K, 6))
const RERANK_MIN_ARTICLE_CHARS = Number(APP?.search?.rerank_min_chars ?? 400)
const LLM_QUERY_EXPAND_ENABLED = Boolean(APP?.search?.llm_query_expand ?? true)
const LLM_QR_ON_LOWCONF        = Boolean(APP?.search?.llm_query_rewrite_on_low_conf ?? true)
const OVERLAP_BONUS_PER_TOKEN  = Number(APP?.search?.overlap_bonus_per_token ?? 0.00)
const OVERLAP_BONUS_MAX        = Number(APP?.search?.overlap_bonus_max       ?? 0.00)
const TAG_MATCH_BONUS          = Number(APP?.search?.tag_match_bonus         ?? 0.04)
const TAG_BYPASS_SIM           = Number(APP?.search?.tag_bypass_sim          ?? 0.70)

// Intents / ranking extra
const INTENTS   = Array.isArray(APP?.intents) ? APP.intents : []
const RWEIGHTS  = APP?.ranking?.weights || { prefer: 0.08, avoid: 0.10 }
const GLOBAL_TERMS = {
  prefer: Array.isArray(APP?.terms?.prefer_terms) ? APP.terms.prefer_terms : [],
  avoid : Array.isArray(APP?.terms?.avoid_terms)  ? APP.terms.avoid_terms  : []
}

// Desambiguación gate
const GATE_BY_DOMAIN   = Boolean(APP?.disambiguation?.gate_by_domain ?? true)
const GENERIC_POLICY   = String(APP?.disambiguation?.generic_single_word_policy || 'refine')
const DOMAIN_HINTS     = Array.isArray(APP?.domain?.hints) ? APP.domain.hints : []
const WH_PREFIXES      = Array.isArray(APP?.domain?.wh_prefixes) ? APP.domain.wh_prefixes : []
const MIN_WORDS_FOR_CHOICES = Math.max(1, Number(APP?.domain?.min_words_for_choices ?? 2))
const ALLOW_YEAR_AS_SIGNAL  = Boolean(APP?.domain?.allow_year_as_signal ?? true)
const REFINE_MESSAGE_TMPL   = String(APP?.domain?.refine_message
  || 'La consulta “{q}” es amplia para esta base. Indicá una pista (institución, año o lugar).')

// DB
const DB = {
  host    : process.env.DB_HOST ?? APP?.db?.host     ?? 'localhost',
  user    : process.env.DB_USER ?? APP?.db?.user     ?? 'museo',
  password: process.env.DB_PASS ?? APP?.db?.password ?? 'museo2025',
  database: process.env.DB_NAME ?? APP?.db?.database ?? 'museo',
}

// App HTTP
const app = express()
app.use(express.json({ limit:'1mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.get('/', (_req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')))

// Caches
let DOCS  = []
let VDOCS = []

// Carga cache desde MySQL
async function loadKnowledgeCache(){
  console.log('[CACHE] Cargando conocimiento desde MySQL…')
  const conn = await mysql.createConnection(DB)
  try{
    const T = 'conocimiento'
    const C = {
      id     : TCONF?.id      ?? 'id',
      title  : TCONF?.title   ?? 'titulo',
      content: TCONF?.content ?? 'contenido',
      date   : TCONF?.date    ?? 'fecha_evento',
      image  : TCONF?.image   ?? 'imagen_url',
      tags   : TCONF?.tags    ?? 'etiquetas',
      source : TCONF?.source  ?? 'fuente_url',
      vector : TCONF?.vector  ?? 'vector',
    }
    const cols = [C.id, C.title, C.content, C.date, C.image, C.tags, C.source, C.vector]
    const [rows] = await conn.execute(`SELECT ${cols.join(', ')} FROM ${T} ORDER BY ${C.date} ASC`)

    DOCS = []
    VDOCS = []
    for (const r of rows){
      const base = {
        id          : r[C.id],
        titulo      : r[C.title],
        contenido   : r[C.content] ?? '',
        fecha_evento: r[C.date],
        imagen_url  : r[C.image] ?? '',
        etiquetas   : r[C.tags] ?? '',
        fuente_url  : r[C.source] ?? '',
      }
      DOCS.push(base)
      try{
        const raw = r[C.vector]
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Array.isArray(arr) && arr.length){
          VDOCS.push({ ...base, vec: Float32Array.from(arr) })
        }
      }catch{}
    }
    console.log(`[CACHE] DOCS: ${DOCS.length} | VDOCS: ${VDOCS.length}`)
  } finally {
    await conn.end()
  }
}

// Helpers fecha/snippet
const formatDate = (d)=>{
  if(!d) return ''
  const dt = new Date(d); if(isNaN(dt)) return ''
  const dd = String(dt.getUTCDate()).padStart(2,'0')
  const mm = String(dt.getUTCMonth()+1).padStart(2,'0')
  const yy = dt.getUTCFullYear()
  return `${dd}-${mm}-${yy}`
}
const buildSnippet = (text='', maxChars=SNIPPET_CHARS)=>{
  const clean = (text||'').trim().replace(/\s+/g,' ')
  return clean.length <= maxChars ? clean : clean.slice(0,maxChars) + '…'
}
function smartSnippet(text, query, maxChars=SNIPPET_CHARS){
  const t = (text||'').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const token = (query||'').split(/\s+/).find(w=>w.length>=4) || ''
  if (!token) return buildSnippet(t, maxChars)
  const i = t.toLowerCase().indexOf(token.toLowerCase())
  if (i<0) return buildSnippet(t, maxChars)
  const half  = Math.floor(maxChars/2)
  const start = Math.max(0, i - half)
  const end   = Math.min(t.length, start + maxChars)
  const slice = t.slice(start, end)
  return (start>0?'…':'') + slice + (end<t.length?'…':'')
}

// Forzar 3–5 líneas en resúmenes
function enforceSummaryLines(text) {
  if (!text) return ""
  let t = String(text).replace(/\r/g, "").trim()
  let lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean)

  if (lines.length < 3) {
    const sents = t
      .replace(/\s+/g, " ")
      .split(/(?<=[\.\!\?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
    lines = sents.slice(0, 5)
  }

  if (lines.length > 5) lines = lines.slice(0, 5)

  while (lines.length < 3) {
    const last = lines.pop() || ""
    const next = lines.pop() || ""
    const merged = [next, last].filter(Boolean).join(" ")
    if (!merged) break
    lines.push(merged)
  }

  lines = lines.map(l => l.replace(/^[\-\*\d\)\.]+\s*/,'').trim())
  return lines.filter(Boolean).join("\n")
}

// Fallback extractivo local (garantiza 3–5 líneas)
function summarizeLocally(raw, maxLines = 5){
  const txt = String(raw || '').replace(/\s+/g,' ').trim()
  if (!txt) return ''
  const sents = txt.split(/(?<=[\.\!\?])\s+/).filter(Boolean)
  const take = Math.min(Math.max(3, Math.ceil(sents.length * 0.15)), maxLines)
  return enforceSummaryLines(sents.slice(0, take).join('\n'))
}

// Mensaje no resultados
function buildNoResultsTip(queryRaw = '') {
  const q = (queryRaw || '').trim()
  const defaultContext = (APP?.search?.default_context || '').trim()
  const hints = [
    'un lugar o institución relacionada',
    'una palabra clave más específica',
    'un detalle adicional sobre el hecho o la persona'
  ]
  const base = q.replace(/"/g, '')
  const ctx  = defaultContext ? ` ${defaultContext}` : ''
  const ejemplos = [
    `${base}${ctx}`,
    `fundación de + ${base}`,
    `${base} institución`,
    `${base}${ctx} organización`
  ]
  let msg = `No encontré datos suficientemente confiables para "${base}". `
  msg += `Probá agregar ${hints.join(', ').replace(', un', ' o un')} para mejorar los resultados 🙂`
  msg += `\n\nEjemplos: ${ejemplos.map(e => `“${e}”`).join(' · ')}`
  return msg
}

// Normalización / similitudes
function norm(s=''){ return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'') }
function spStem(token=''){
  let t = token.toLowerCase()
  t = t.normalize('NFD').replace(/\p{Diacritic}/gu,'')
  const cuts = ['ciones','siones','mente','idades','adora','adores','adoras','acion','sion','idad','ados','adas','idos','idas','ando','iendo','ador','cion','do','da','os','as','ar','er','ir','ado','ada','ido','ida']
  for (const suf of cuts){
    if (t.endsWith(suf) && t.length - suf.length >= 4){ t = t.slice(0, -suf.length); break; }
  }
  return t
}
function tokenOverlapCount(query, doc){
  const qTokens = norm(query).split(/\W+/).filter(w=>w.length>=4)
  if (!qTokens.length) return 0
  const hay = norm(`${doc.titulo||''} ${doc.contenido||''} ${doc.etiquetas||''}`)
  let m = 0
  for (const tok of qTokens){
    const base = spStem(tok)
    if (hay.includes(tok) || (base.length>=4 && hay.includes(base))) m++
  }
  return m
}
function singularize(w=''){ return w.replace(/[0-9]+/g,'').replace(/(es|s)$/,'') }
function toTokenSet(s=''){ return new Set(norm(s).split(/\W+/).filter(Boolean).map(singularize)) }
function jaccard(aSet, bSet){
  let inter = 0; for (const x of aSet) if (bSet.has(x)) inter++
  const union = aSet.size + bSet.size - inter
  return union ? inter/union : 0
}
function bestTagSim(queryText='', etiquetas=''){
  const qSet = toTokenSet(queryText)
  if (!qSet.size) return 0
  const tags = String(etiquetas||'').split(',').map(s=>s.trim()).filter(Boolean)
  let best = 0
  for (const t of tags){
    const sim = jaccard(qSet, toTokenSet(t))
    if (sim > best) best = sim
  }
  return best
}

// Tiempo / budget
function now(){ return performance.now() }
function timeLeft(start, budget){ return Math.max(0, budget - (now() - start)) }
function clampTimeout(ms){ return Math.max(100, Math.min(ms|0, 60000)) }

// Cliente /embed
async function embedText(text, timeoutMs){
  const controller = new AbortController()
  const to = setTimeout(()=>controller.abort(), clampTimeout(timeoutMs ?? PERF_EMBED_TMOUT ?? EMBED_TMOUT_GLOBAL))
  try{
    const resp = await fetch(EMBED_URL, {
      method : 'POST',
      headers: { 'Content-Type':'application/json; charset=utf-8' },
      body   : JSON.stringify({ text }),
      signal : controller.signal
    })
    if(!resp.ok) throw new Error(`Flask /embed respondió ${resp.status}`)
    const data = await resp.json()
    let arr = null
    if (Array.isArray(data.embedding)) arr = data.embedding
    else if (Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])) arr = data.embeddings[0]
    if (!arr) throw new Error('Respuesta de /embed inválida')
    return Float32Array.from(arr)
  } catch (e) {
    const err = new Error(`No pude conectar con /embed`)
    err.cause = e
    err.code = 'EMBED_DOWN'
    throw err
  } finally { clearTimeout(to) }
}

// Motor vectorial
function cosineSim(a,b){
  let dot=0, na=0, nb=0
  const n = Math.min(a.length,b.length)
  for (let i=0;i<n;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y }
  const denom = Math.sqrt(na)*Math.sqrt(nb)
  return denom ? dot/denom : 0
}
function searchTopKWithBonus(queryText, queryVec, topK = TOP_K, threshold = SIM_THRESHOLD) {
  const hits = []
  for (const item of VDOCS) {
    const sim = cosineSim(queryVec, item.vec)
    const tagSim   = bestTagSim(queryText, item.etiquetas)
    const tagBonus = TAG_MATCH_BONUS * tagSim

    if (sim < threshold && tagSim < TAG_BYPASS_SIM) continue

    const overlap = tokenOverlapCount(queryText, item)
    const overlapBonus = Math.min(overlap * OVERLAP_BONUS_PER_TOKEN, OVERLAP_BONUS_MAX)

    const score = sim + overlapBonus + tagBonus
    hits.push({ item, score, sim, overlap, tagSim, tagBonus, _score: score })
  }
  hits.sort((a,b)=> b._score - a._score)
  return hits.slice(0, topK)
}

// Intents / ranking
function detectIntentGeneric(q = '') {
  for (const rule of INTENTS) {
    if (!rule?.detect) continue
    try {
      const rx = new RegExp(rule.detect, 'i')
      if (rx.test(q)) return rule
    } catch {}
  }
  return null
}
function countTerms(text, terms) {
  if (!terms?.length) return 0
  const hay = (text || '').toLowerCase()
  let n = 0
  for (const t of terms) {
    const needle = String(t || '').toLowerCase().trim()
    if (!needle) continue
    if (hay.includes(needle)) n++
  }
  return n
}

// Boost fuerte para “fundación de Realicó”
function strongFoundationBoost(q, hits){
  const s = norm(q)
  const askFund = /(fundaci[oó]n|fundad|fund[oó])/.test(s)
  const askWhen = /(cuand[oó]|fecha)/.test(s)
  const hasRealic = /realic/.test(s)
  if (!(askFund && (askWhen || hasRealic))) return
  for (const h of hits){
    const title = norm(h.item.titulo || '')
    const superHit = title.includes('fundacion') && title.includes('realic')
    if (superHit) h._score += 0.50
  }
  hits.sort((a,b)=> b._score - a._score)
}

function applyGenericAdjustments(hits, rule) {
  if (!hits?.length) return
  const prefer = [...(GLOBAL_TERMS.prefer || []), ...(rule?.prefer_terms || [])]
  const avoid  = [...(GLOBAL_TERMS.avoid  || []), ...(rule?.avoid_terms  || [])]
  for (const h of hits) {
    const combo = `${h.item.titulo||''} ${h.item.contenido||''} ${h.item.etiquetas||''}`
    const p = countTerms(combo, prefer)
    const a = countTerms(combo, avoid)
    h._score += (p * (RWEIGHTS.prefer ?? 0.08)) - (a * (RWEIGHTS.avoid ?? 0.10))
  }
  hits.sort((x,y)=> y._score - x._score)
}
function detectIntentHeuristics(q=''){
  const s = (q||'').toLowerCase()
  const hasFund = /(fundaci[oó]n|fundad|fund[oó])/.test(s)
  const hasCuando = /(cuand[oó])/.test(s)
  const hasFecha = /(fecha)/.test(s)
  if ((hasFund && (hasCuando||hasFecha)) || (/^fundaci[oó]n\b/.test(s))) {
    return {
      prompt: 'short_date',
      prefer_terms: ['fundación','fundada','fundó','fundar','origen','acto fundacional'],
      avoid_terms: []
    }
  }
  if (/^\s*resum/i.test(s)) {
    return { prompt: 'summary', prefer_terms: [], avoid_terms: [] }
  }
  return null
}

// Respuesta V2 base
function formatAnswer(best, queryForSnippet){
  const fecha = formatDate(best.fecha_evento)
  const snip  = smartSnippet(best.contenido||'', queryForSnippet, SNIPPET_CHARS)
  return `${best.titulo}${fecha ? ` — ${fecha}` : ''}\n${snip}`
}

// Parse de respuestas LLM (simple; dejamos función robusta en tryRewriteWithLLM)
function extractTextFromLlamaResponse(j) {
  if (!j) return ''
  if (typeof j.content === 'string') return j.content
  if (Array.isArray(j.content)) {
    const t = j.content.map(x => (x?.text || '')).join('')
    if (t.trim()) return t
  }
  const ch0 = j.choices?.[0]
  if (typeof ch0?.text === 'string') return ch0.text
  if (typeof ch0?.content === 'string') return ch0.content
  if (Array.isArray(ch0?.content)) {
    const t = ch0.content.map(x => (x?.text || '')).join('')
    if (t.trim()) return t
  }
  if (typeof j.generation === 'string') return j.generation
  return ''
}

// Prompts LLM
function buildPrompt({ best, preguntaRaw, promptMode }) {
  const context =
    `${best.titulo || ""}\n` +
    (best.fecha_evento ? `Fecha: ${formatDate(best.fecha_evento)}\n` : "") +
    smartSnippet(best.contenido || "", preguntaRaw, SNIPPET_CHARS)

  if (promptMode === 'short_date') {
    return [
      "Sos un redactor del museo. No inventes nada.",
      "Si el contexto contiene una fecha de fundación, respondé SOLO con:",
      "1) La fecha (DD-MM-AAAA si está; si no, AAAA).",
      "2) Una sola frase breve (máx. 20 palabras).",
      "",
      "Contexto:", context, "",
      "Pregunta:", preguntaRaw, "",
      "Respuesta (máx. 2 líneas). Al final: (Redactado por LLaMA)"
    ].join("\n")
  }

  if (promptMode === 'summary') {
    return [
      "Sos un redactor del museo. No inventes nada.",
      "Resumí el contexto en 3–5 líneas: idea central + 2 datos clave (fechas/lugares).",
      "Nada de opinión ni adornos. Español claro y conciso.",
      "",
      "Contexto:", context, "",
      "Respuesta (al final: (Redactado por LLaMA)):"
    ].join("\n")
  }

  // modo natural
  return [
    "Sos un redactor neutral y cordial. No inventes nada.",
    "Redactá en español un mensaje breve, claro y humano usando SOLO este contexto.",
    "Si el usuario pide 'resumí', devolvé 3–5 líneas con idea central y 2 datos clave.",
    "",
    "Contexto:", context, "",
    "Pregunta:", preguntaRaw, "",
    "Respuesta (agregá al final: (Redactado por LLaMA)):"
  ].join("\n")
}

// Prompt custom para acciones
function buildCustomActionPrompt(best, actionPrompt, preguntaRaw) {
  const ctx =
    `${best.titulo || ""}\n` +
    (best.fecha_evento ? `Fecha: ${formatDate(best.fecha_evento)}\n` : "") +
    smartSnippet(best.contenido || "", preguntaRaw, SNIPPET_CHARS)

  return [ actionPrompt.trim(), "", "Contexto:", ctx, "", "Respuesta:" ].join("\n")
}

// Reescritura con LLM (acepta customPrompt) + normaliza a 3–5 líneas en modo resumen
async function tryRewriteWithLLM({ best, preguntaRaw, promptMode, timeoutMs, customPrompt }) {
  if (!APP?.llm?.enabled)
    return { used:false, text:null, error:null, elapsed_ms:0, prompt_chars:0, url: String(APP?.llm?.url||'') }

  const prompt = customPrompt || buildPrompt({ best, preguntaRaw, promptMode })
  const url    = String(APP?.llm?.url || 'http://127.0.0.1:8081/completion')

  const isSummary = (promptMode === 'summary') || /resum/i.test(String(customPrompt||''))
  const timeout   = clampTimeout(timeoutMs ?? (isSummary ? SUMMARY_STEP_MAX_MS : Number(APP?.llm?.timeout_ms ?? 12000)))

  // ⚠️ Sin stop:["\n\n"]; generamos libre y recortamos nosotros a 3–5 líneas
  const body = {
    prompt,
    temperature: (promptMode === 'short_date') ? 0.2 : 0.3,
    n_predict  : isSummary ? 240 : ((promptMode === 'short_date') ? 120 : 300)
  }

  const started = now()
  const controller = new AbortController()
  const to = setTimeout(()=>controller.abort(), timeout)

  try{
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const elapsed_ms = Math.round(now() - started)
    if (!r.ok) {
      return { used:false, text:null, error:`http_${r.status}`, elapsed_ms, prompt_chars:prompt.length, url }
    }
    const j = await r.json()

    // Parser robusto: soporta llama.cpp, text-gen, kobold, ollama…
    let raw =
      (typeof j.content === 'string' && j.content) ||
      (Array.isArray(j.content) && j.content.map(x => x?.text || x?.content || '').join('')) ||
      (j.choices && typeof j.choices[0]?.text === 'string' && j.choices[0].text) ||
      (j.choices && typeof j.choices[0]?.content === 'string' && j.choices[0].content) ||
      (j.generation && typeof j.generation === 'string' && j.generation) ||
      (typeof j.response === 'string' && j.response) || // Ollama
      ''

    raw = String(raw).trim()
    const text = isSummary ? enforceSummaryLines(raw) : raw
    const used = Boolean(text)

    return { used, text: used ? text : null, error: used ? null : 'empty', elapsed_ms, prompt_chars: prompt.length, url }
  } catch (err) {
    const elapsed_ms = Math.round(now() - started)
    return { used:false, text:null, error:(err?.name||'error'), elapsed_ms, prompt_chars:prompt.length, url }
  } finally {
    clearTimeout(to)
  }
}

// Rerank LLM
async function rerankWithLlama(query, candidates, llamaUrl, perCallTimeoutMs) {
  if (!Array.isArray(candidates) || !candidates.length) return []

  const url = String(llamaUrl || APP?.llm?.url || '')
  if (!url) return []

  const limited = candidates.slice(0, RERANK_MAX_CAND)
  const prompts = limited.map(c=>{
    const context = `${c.titulo || ''}${c.fecha_evento ? ` — ${formatDate(c.fecha_evento)}` : ''}\n${buildSnippet(c.contenido || '', 800)}`
    return {
      id: c.id,
      item: c,
      body: {
        prompt: [
          "Sos un evaluador. Dada una CONSULTA y un TEXTO, devolvé solo un número de 0 a 100 (entero).",
          "0 = nada que ver, 100 = responde perfecto.",
          "", "CONSULTA:", query, "", "TEXTO:", context, "", "Salida:"
        ].join("\n"),
        temperature: 0.0,
        n_predict: 16
      }
    }
  })

  const tasks = prompts.map(p => (async ()=>{
    const controller = new AbortController()
    const to = setTimeout(()=>controller.abort(), clampTimeout(perCallTimeoutMs ?? LLM_STEP_MAX_MS))
    try{
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(p.body), signal: controller.signal })
      if (!r.ok) return { id:p.id, item:p.item, score:0 }
      const j = await r.json()
      const txt = (extractTextFromLlamaResponse(j) || '').trim()
      const m = txt.match(/^\s*(\d{1,3})\s*$/)
      const score = Math.max(0, Math.min(100, m ? parseInt(m[1],10) : 0))
      return { id:p.id, item:p.item, score }
    } catch { return { id:p.id, item:p.item, score:0 } }
    finally { clearTimeout(to) }
  })())

  const settled = await Promise.allSettled(tasks)
  const results = settled.map(s => s.value || s.reason).filter(Boolean)
  results.sort((a,b)=> b.score - a.score)
  return results.map(x=>x.item)
}

// Query rewrite (no hits / low-conf)
async function rewriteQueryWithLlama(query, timeoutMs) {
  const url = String(APP?.llm?.url || '')
  if (!url) return null
  const body = {
    prompt: [
      "Vas a mejorar una consulta corta para un buscador semántico en español.",
      "Corregí typos y devolvé UNA consulta mejorada (3–8 palabras clave).",
      "No inventes nombres propios.",
      "", "Consulta original:", query, "", "Devolvé solo la consulta:"
    ].join("\n"),
    temperature: 0.2,
    n_predict: 64
  }

  const controller = new AbortController()
  const to = setTimeout(()=>controller.abort(), clampTimeout(timeoutMs ?? LLM_STEP_MAX_MS))
  try {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: controller.signal })
    if (!r.ok) return null
    const j = await r.json()
    const text = (extractTextFromLlamaResponse(j) || '').trim()
    const out = text.replace(/[\r\n]+/g,' ').replace(/["']/g,'').trim()
    return out || null
  } catch { return null }
  finally { clearTimeout(to) }
}

// ======= DOMAIN GATE HELPERS =======
function wordCount(s){ return (s||'').trim().split(/\s+/).filter(Boolean).length }
function hasYear(s){ return ALLOW_YEAR_AS_SIGNAL && /\b(18|19|20)\d{2}\b/.test((s||'').toLowerCase()) }
function hasDomainHint(s){
  const q = (s||'').toLowerCase()
  return DOMAIN_HINTS.some(h => q.includes(String(h).toLowerCase()))
}
function startsWithWhPrefix(s){
  const q = (s||'').toLowerCase().trim()
  return WH_PREFIXES.some(w => q.startsWith(String(w).toLowerCase() + ' '))
}
function shouldShowDocChoices(query){
  if (!GATE_BY_DOMAIN) return true
  if (!query || typeof query !== 'string') return false
  const wc = wordCount(query)
  if (wc >= MIN_WORDS_FOR_CHOICES) return true
  if (hasYear(query)) return true
  if (hasDomainHint(query)) return true
  if (startsWithWhPrefix(query)) return true
  return GENERIC_POLICY === 'choices' ? true : false
}
function buildRefineDomainMessage(qRaw){
  const q = (qRaw||'').trim()
  return REFINE_MESSAGE_TMPL.replace('{q}', q || 'tu consulta')
}

// ================================
// ============ /ask ==============
// ================================
app.post('/ask', async (req,res)=>{
  const t0 = now()

  const preguntaRaw  = String(req.body?.pregunta || '').trim()
  let   forceId      = Number(req.body?.forceId ?? 0)   // let: puede venir dentro de 'action'
  const preguntaNorm = norm(preguntaRaw)

  // action puede ser string u objeto
  const actionRaw = req.body?.action
  const payload   = req.body?.payload || (typeof actionRaw === 'object' ? actionRaw.payload : null)

  let action = ''
  if (typeof actionRaw === 'string') {
    action = actionRaw.trim().toLowerCase()
  } else if (actionRaw && typeof actionRaw === 'object') {
    action = String(actionRaw.action || actionRaw.name || actionRaw.type || '').trim().toLowerCase()
    if (!forceId && actionRaw.id) {
      const maybeId = Number(actionRaw.id)
      if (Number.isFinite(maybeId)) forceId = maybeId
    }
  }

  if (!preguntaNorm && !forceId){
    return res.status(400).json({ error:"Falta el campo 'pregunta'." })
  }

  const llmExpect = Boolean(APP?.llm?.enabled)

  try{
    // -- Apertura directa por ID (con acción opcional summarize)
    if (forceId) {
      const best = DOCS.find(d => d.id === forceId)
      if (!best) {
        return res.json({
          pregunta: preguntaRaw || `Abrir documento #${forceId}`,
          respuesta: 'No pude abrir ese documento.',
          need_choice: false,
          meta: { llm: { expect: llmExpect, used: false, elapsed_ms: 0 },
                  budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
        })
      }

      // Acción: resumen con LLaMA (puede venir prompt custom)
      if (action === 'summarize') {
        let metaLLM = {
          expect: llmExpect, used: false, elapsed_ms: 0, error: null,
          url: String(APP?.llm?.url || ''), prompt_mode: 'summary', prompt_chars: 0
        }

        const actionPrompt = (payload?.action_prompt || '').trim()
        const customPrompt = actionPrompt ? buildCustomActionPrompt(best, actionPrompt, preguntaRaw || 'resumen breve') : null

        const { used, text, error, elapsed_ms, prompt_chars, url } = await tryRewriteWithLLM({
          best,
          preguntaRaw: preguntaRaw || 'Resumí el artículo',
          promptMode: customPrompt ? undefined : 'summary',
          customPrompt,
          timeoutMs: Math.min(SUMMARY_STEP_MAX_MS, timeLeft(t0, PERF_BUDGET_MS))
        })

        metaLLM = { ...metaLLM, used, elapsed_ms, error, url, prompt_chars }

        // 🔒 Fallback extractivo local si el LLM no devuelve nada
        let finalText = (text || '').trim()
        if (!finalText) finalText = summarizeLocally(best.contenido, 5)
        finalText = enforceSummaryLines(finalText)

        const mark = used ? String(APP?.llm?.mark ?? ' ✨LLM') : ' (resumen automático)'
        const final = finalText + mark

        return res.json({
          pregunta: preguntaRaw || `Resumen: ${best.titulo}`,
          respuesta: final,
          need_choice: false,
          meta: {
            llm: metaLLM,
            ui: { suggest_summary: false },
            budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) }
          }
        })
      }

      // Apertura sin acción → respuesta base + acción sugerida
      const respuestaV2 = formatAnswer(best, preguntaRaw)
      let respuestaFinal = respuestaV2
      let metaLLM = {
        expect: llmExpect, used: false, elapsed_ms: 0, error: null,
        url: String(APP?.llm?.url || ''), prompt_mode: 'natural', prompt_chars: 0
      }

      const articleLen  = (best.contenido || '').trim().replace(/\s+/g, ' ').length
      const shouldUseLLM =
        Boolean(APP?.llm?.enabled) &&
        articleLen >= LLM_MIN_CHARS &&
        1.0 >= LLM_MIN_SCORE &&
        timeLeft(t0, PERF_BUDGET_MS) > LLM_STEP_MAX_MS

      metaLLM.debug = { via:'forceId', article_len: articleLen, min_chars: LLM_MIN_CHARS, top_score: 1.0, min_score: LLM_MIN_SCORE, should_use: shouldUseLLM }

      if (shouldUseLLM) {
        const { used, text, error, elapsed_ms, prompt_chars, url } =
          await tryRewriteWithLLM({
            best,
            preguntaRaw,
            promptMode: 'natural',
            timeoutMs: Math.min(LLM_STEP_MAX_MS, timeLeft(t0, PERF_BUDGET_MS))
          })

        metaLLM = { ...metaLLM, used, elapsed_ms, error, url, prompt_chars }

        if (used && text) {
          const mark = String(APP?.llm?.mark ?? ' ✨LLM')
          respuestaFinal = text.trim() + mark
        }
      }

      return res.json({
        pregunta: preguntaRaw || `Abrir: ${best.titulo}`,
        respuesta: respuestaFinal,
        need_choice: false,
        meta: {
          llm: metaLLM,
          ui: { suggest_summary: true },
          actions: [{ type:'summarize', id: best.id, label:'Resumir con LLaMA'}],
          budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) }
        }
      })
    }

    // -- Embeddings + búsqueda
    const qVec = await embedText(preguntaNorm, Math.min(PERF_EMBED_TMOUT, timeLeft(t0, PERF_BUDGET_MS)))
    let hits = searchTopKWithBonus(preguntaRaw, qVec, TOP_K, SIM_THRESHOLD)

    // Filtro léxico mínimo (si hay tokens de 4+)
    const hasTokens = preguntaNorm.split(/\W+/).filter(w=>w.length>=4).length > 0
    if (hasTokens){
      const filtered = hits.filter(h=> tokenOverlapCount(preguntaRaw, h.item) > 0)
      if (filtered.length) hits = filtered
    }

    // Sin hits → query rewrite + reintento
    if (!hits.length && APP?.llm?.enabled && LLM_QUERY_EXPAND_ENABLED && timeLeft(t0, PERF_BUDGET_MS) > LLM_STEP_MAX_MS){
      const qRew = await rewriteQueryWithLlama(preguntaRaw, Math.min(LLM_STEP_MAX_MS, timeLeft(t0, PERF_BUDGET_MS)))
      if (qRew && qRew !== preguntaRaw) {
        try {
          const qVec2 = await embedText(norm(qRew), Math.min(PERF_EMBED_TMOUT, timeLeft(t0, PERF_BUDGET_MS)))
          let hits2 = searchTopKWithBonus(qRew, qVec2, TOP_K, SIM_THRESHOLD)
          if (hasTokens){
            const filtered2 = hits2.filter(h=> tokenOverlapCount(qRew, h.item) > 0)
            if (filtered2.length) hits2 = filtered2
          }
          if (hits2.length) hits = hits2
        } catch {}
      }
    }

    // Intent + boosts
    let intent = detectIntentGeneric(preguntaRaw)
    if (!intent) intent = detectIntentHeuristics(preguntaRaw)
    if (intent) applyGenericAdjustments(hits, intent)
    strongFoundationBoost(preguntaRaw, hits)

    // Preferir año exacto si está en la query
    const yearMatch = (preguntaRaw.match(/\b(18|19|20)\d{2}\b/) || [])[0]
    if (yearMatch){
      const prefer = hits.filter(h=>{
        const y = new Date(h.item.fecha_evento).getUTCFullYear()
        return Number.isFinite(y) && y === parseInt(yearMatch,10)
      })
      if (prefer.length) hits = prefer
    }

    // Rerank con LLM
    if (RERANK_ENABLED && APP?.llm?.enabled && timeLeft(t0, PERF_BUDGET_MS) > LLM_STEP_MAX_MS){
      const cand = hits.slice(0, RERANK_TOPK).map(h => h.item)
      const longEnough = cand.some(c => (String(c.contenido||'').replace(/\s+/g,' ').length) >= RERANK_MIN_ARTICLE_CHARS)
      if (cand.length >= 2 && longEnough) {
        const ordered = await rerankWithLlama(preguntaRaw, cand, APP?.llm?.url, Math.min(LLM_STEP_MAX_MS, timeLeft(t0, PERF_BUDGET_MS)))
        if (ordered && ordered.length) {
          const pos = new Map(ordered.map((it,idx)=>[it.id, idx]))
          hits.sort((a,b)=> (pos.get(a.item.id) ?? 999) - (pos.get(b.item.id) ?? 999))
        }
      }
    }

    const debugTop = hits.slice(0,5).map(h=>({ id:h.item.id, title:h.item.titulo, _score:+(h._score||0).toFixed(3), sim:+h.sim.toFixed(3), tagSim:+h.tagSim.toFixed(3), overlap:h.overlap }))

    // Confianza baja → desambiguación
    const topScore = (hits[0]._score ?? hits[0].score) ?? 0
    if (topScore < MIN_BEST){
      const options = hits.slice(0, Math.min(hits.length, 5)).map(h=>({
        id: h.item.id,
        title: h.item.titulo,
        date: h.item.fecha_evento,
        preview: buildSnippet(h.item.contenido||'', 160)
      }))

      if (options.length >= 2){
        if (shouldShowDocChoices(preguntaRaw)) {
          return res.json({
            pregunta: preguntaRaw,
            need_choice:true,
            options,
            mensaje:'Encontré varias opciones parecidas. Elegí una:',
            meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                    ranking: { debug: debugTop },
                    ui: { suggest_summary: false },
                    budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
          })
        } else {
          if (GENERIC_POLICY === 'choices') {
            return res.json({
              pregunta: preguntaRaw,
              need_choice:true,
              options,
              mensaje:'Encontré varias opciones parecidas. Elegí una:',
              meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                      ranking: { debug: debugTop },
                      ui: { suggest_summary: false },
                      budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
            })
          }
          return res.json({
            pregunta: preguntaRaw,
            need_choice:false,
            respuesta: buildRefineDomainMessage(preguntaRaw),
            meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                    ranking: { debug: debugTop },
                    ui: { suggest_summary: false },
                    budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
          })
        }
      }

      // Tip si no hay opciones suficientes
      return res.json({
        pregunta: preguntaRaw,
        respuesta: buildNoResultsTip(preguntaRaw),
        need_choice:false,
        meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                ranking: { debug: debugTop },
                ui: { suggest_summary: false },
                budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
      })
    }

    // Empate cercano → opciones
    const top = topScore
    const close = hits.filter(h => (top - (h._score ?? h.score)) <= CHOICE_DELTA)
    if (close.length >= 2){
      const options = close.map(h=>({
        id: h.item.id, title: h.item.titulo, date: h.item.fecha_evento,
        preview: buildSnippet(h.item.contenido||'', 160)
      }))

      if (shouldShowDocChoices(preguntaRaw)) {
        return res.json({
          pregunta: preguntaRaw,
          need_choice:true,
          options,
          mensaje:'Encontré varias opciones parecidas. Elegí una:',
          meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                  ranking: { debug: debugTop },
                  ui: { suggest_summary: false },
                  budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
        })
      } else {
        if (GENERIC_POLICY === 'choices') {
          return res.json({
            pregunta: preguntaRaw,
            need_choice:true,
            options,
            mensaje:'Encontré varias opciones parecidas. Elegí una:',
            meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                    ranking: { debug: debugTop },
                    ui: { suggest_summary: false },
                    budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
          })
        }
        return res.json({
          pregunta: preguntaRaw,
          need_choice:false,
          respuesta: buildRefineDomainMessage(preguntaRaw),
          meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                  ranking: { debug: debugTop },
                  ui: { suggest_summary: false },
                  budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
        })
      }
    }

    // Caso normal
    const best = hits[0].item
    const respuestaV2 = formatAnswer(best, preguntaRaw)

    // Reescritura condicional
    let respuestaFinal = respuestaV2
    let metaLLM = {
      expect: llmExpect, used: false, elapsed_ms: 0, error: null,
      url: String(APP?.llm?.url || ''), prompt_mode: intent?.prompt || 'natural', prompt_chars: 0
    }

    const articleLen  = (best.contenido || '').trim().replace(/\s+/g, ' ').length
    const topHitScore = (hits?.[0]?._score ?? hits?.[0]?.score ?? 0)
    const shouldUseLLM =
      Boolean(APP?.llm?.enabled) &&
      articleLen >= LLM_MIN_CHARS &&
      topHitScore >= LLM_MIN_SCORE &&
      timeLeft(t0, PERF_BUDGET_MS) > LLM_STEP_MAX_MS

    metaLLM.debug = {
      article_len: articleLen, min_chars: LLM_MIN_CHARS,
      top_score: topHitScore, min_score: LLM_MIN_SCORE, should_use: shouldUseLLM
    }

    if (shouldUseLLM) {
      const { used, text, error, elapsed_ms, prompt_chars, url } = await tryRewriteWithLLM({
        best, preguntaRaw, promptMode: intent?.prompt || 'natural',
        timeoutMs: Math.min(LLM_STEP_MAX_MS, timeLeft(t0, PERF_BUDGET_MS))
      })
      metaLLM = { ...metaLLM, used, elapsed_ms, error, url, prompt_chars }
      if (used && text) {
        const mark = String(APP?.llm?.mark ?? ' ✨LLM')
        respuestaFinal = text.trim() + mark
      }
    }

    const actions = []
    if (Boolean(APP?.llm?.enabled) &&
        (best.contenido||'').replace(/\s+/g,' ').length >= LLM_SUMMARIZE_MIN_CHARS) {
      actions.push({ type:'summarize', id: best.id, label:'Resumir con LLaMA' })
    }

    return res.json({
      pregunta: preguntaRaw,
      respuesta: respuestaFinal,
      need_choice:false,
      meta: {
        llm: metaLLM,
        ranking: { debug: debugTop },
        ui: { suggest_summary: true },
        actions,
        budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) }
      }
    })
  } catch(e){
    if (e?.code === 'EMBED_DOWN') {
      return res.status(503).json({
        error: 'embeddings_offline',
        mensaje: 'El servicio de embeddings está temporalmente no disponible. Probá de nuevo en unos segundos.',
        meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
                ui: { suggest_summary: false },
                budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
      })
    }
    return res.status(500).json({ error:'Error interno del servidor',
      meta: { llm: { expect: llmExpect, used:false, elapsed_ms:0 },
              ui: { suggest_summary: false },
              budget: { budget_ms: PERF_BUDGET_MS, spent_ms: Math.round(now()-t0), left_ms: Math.max(0, Math.round(timeLeft(t0, PERF_BUDGET_MS))) } }
    })
  }
})

// /api/timeline
app.get('/api/timeline', (_req,res)=>{
  const data = DOCS
    .map(x=>({ titulo:x.titulo, fecha:x.fecha_evento, imagen_url:x.imagen_url||'' }))
    .sort((a,b)=> new Date(a.fecha) - new Date(b.fecha))
  res.json(data)
})

// /api/feedback
app.post('/api/feedback', async (req,res)=>{
  try{
    const raw = (req.body?.pulgar ?? req.body?.label ?? '').toString().toLowerCase()
    const pulgar =
      raw==='up'||raw==='arriba' ? 'arriba' :
      raw==='down'||raw==='abajo' ? 'abajo' : ''

    const pregunta  = String(req.body?.pregunta  ?? req.body?.question ?? '').trim()
    const respuesta = String(req.body?.respuesta ?? req.body?.answer   ?? '').trim()

    const line = `"${new Date().toISOString()}","${pulgar}","${pregunta.replace(/"/g,'""')}","${respuesta.replace(/"/g,'""')}"\n`
    fs.appendFileSync(path.join(__dirname,'feedback.csv'), line, 'utf-8')

    if (pulgar){
      const FB_T = 'retroalimentacion'
      const FB_C = {
        id        : FBCONF?.id         ?? 'id',
        created_at: FBCONF?.created_at ?? 'fecha_creacion',
        thumb     : FBCONF?.thumb      ?? 'pulgar',
        question  : FBCONF?.question   ?? 'pregunta',
        answer    : FBCONF?.answer     ?? 'respuesta',
        ip        : FBCONF?.ip         ?? 'ip_cliente',
        ua        : FBCONF?.ua         ?? 'agente_usuario',
      }

      const conn = await mysql.createConnection(DB)
      try{
        await conn.execute(
          `INSERT INTO ${FB_T} (${FB_C.thumb},${FB_C.question},${FB_C.answer},${FB_C.ip},${FB_C.ua})
           VALUES (?,?,?,?,?)`,
          [
            pulgar,
            pregunta,
            respuesta,
            (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString(),
            String(req.headers['user-agent'] || '')
          ]
        )
      } finally { await conn.end() }
    }

    res.json({ ok:true })
  }catch(e){
    res.status(500).json({ ok:false })
  }
})

// /api/health
app.get('/api/health', async (_req,res)=>{
  let embedOk=false
  try{
    const v = await embedText('hola', 600)
    embedOk = Array.isArray(v) && v.length>0
  }catch{}
  res.json({
    ok:true,
    docs:DOCS.length,
    vdocs:VDOCS.length,
    embedUrl:EMBED_URL,
    embedOk,
    llmEnabled: Boolean(APP?.llm?.enabled),
    llmUrl: String(APP?.llm?.url||'')
  })
})

// /api/cache/reload
app.post('/api/cache/reload', async (_req,res)=>{
  try{
    await loadKnowledgeCache()
    res.json({ ok:true, docs:DOCS.length, vdocs:VDOCS.length })
  } catch(e){
    res.status(500).json({ error:'No se pudo recargar' })
  }
})

// Arranque del servidor
app.listen(PORT, async ()=>{
  try{ await loadKnowledgeCache() } catch(e){ console.error('[CACHE] load', e) }
  console.log(`Servidor web en http://localhost:${PORT}`)
})
