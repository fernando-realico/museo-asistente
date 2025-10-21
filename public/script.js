/* ============================================================
 *  Museo Histórico de Realicó – script.js (UI v3 con “Pensando…” + Resize Grip)
 *  Frontend (timeline + chat + feedback + acciones LLM + resize dinámico)
 * ============================================================ */

/* =========================
 * ========== util =========
 * ========================= */

// SVG de reserva cuando no hay imagen
const FALLBACK_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='500'>
       <rect width='100%' height='100%' fill='#0b1220'/>
       <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
             fill='#9ca3af' font-family='system-ui, sans-serif' font-size='20'>
         imagen no disponible
       </text>
     </svg>`
  );

// Acceso rápido al contenedor del chat
const logEl = () => document.getElementById("chat-log");

// Flag antiespam (evita dobles envíos)
window.chatBusy = false;

/* ---------- helpers de scroll ---------- */

// ¿el usuario está cerca del fondo?
function isNearBottom(el, px = 60) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}

// Baja el log hasta el final (con opción de forzar)
function scrollToBottom(smooth = true, force = false) {
  const log = logEl();
  if (!log) return;
  if (!force && !isNearBottom(log)) return;
  if (smooth && typeof log.scrollTo === "function") {
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  } else {
    log.scrollTop = log.scrollHeight;
  }
}

// Asegura que el borde inferior del panel de chat quede visible en viewport
function ensureChatBottomInView() {
  const chat = document.querySelector(".chat");
  if (!chat) return;
  const r = chat.getBoundingClientRect();
  const needScroll = r.bottom > window.innerHeight || r.top < 0;
  if (needScroll) chat.scrollIntoView({ behavior: "smooth", block: "end" });
}

// Combo: baja el log y asegura visibilidad del input/borde inferior
function settleChatView(forceBottom = false) {
  scrollToBottom(false, forceBottom);
  requestAnimationFrame(() => ensureChatBottomInView());
}

// Fecha/hora con formato
const nowStamp = () => {
  const d = new Date();
  const day = d.getDate();
  const mon = d.getMonth() + 1;
  const yr = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${day}-${mon}-${yr} - hora ${hh}:${mm}:${ss}`;
};

// Escapa HTML simple para evitar inyección
const escapeHtml = (s = "") =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// Fecha ISO → DD-MM-YYYY
const formatDate = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = d.getUTCFullYear();
  return `${dd}-${mm}-${yy}`;
};

/* =================================
 * ========== timeline =============
 * ================================= */

async function pintarTimeline() {
  const el = document.getElementById("timeline");
  if (!el) return;
  el.innerHTML = "";
  try {
    const r = await fetch("/api/timeline", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      el.innerHTML = `<div class="empty">No hay eventos para mostrar.</div>`;
      return;
    }
    for (const t of data) {
      const card = document.createElement("div");
      card.className = "card";

      const img = document.createElement("img");
      img.src = t.imagen_url || FALLBACK_IMG;
      img.alt = t.titulo || "Imagen del evento";
      img.loading = "lazy";
      img.onerror = () => (img.src = FALLBACK_IMG);

      const info = document.createElement("div");
      info.className = "info";
      const fecha = t.fecha || t.fecha_evento || "";
      info.innerHTML = `<h3>${escapeHtml(t.titulo || "")}</h3><p>${formatDate(
        fecha
      )}</p>`;

      card.appendChild(img);
      card.appendChild(info);
      el.appendChild(card);
    }
  } catch {
    el.innerHTML = `<div class="empty">No se pudo cargar la línea de tiempo.</div>`;
  }
}

/* ================================
 * ========== chat ui =============
 * ================================ */

// Agrega un mensaje al log (tipo: "me" o "bot" o "error")
function agregarMensaje(html, tipo = "bot") {
  const wrap = document.createElement("div");
  wrap.className = `msg ${tipo}`;
  wrap.innerHTML = `<div class="meta">${
    tipo === "me" ? "Vos" : "Asistente"
  } · ${nowStamp()}</div>${html}`;

  const log = logEl();
  if (!log) return wrap;
  log.appendChild(wrap);

  settleChatView(false);
  return wrap;
}

// Inserta una chapita “LLM” en un mensaje del asistente
function addLLMBadge(container, elapsedMs = null) {
  if (!container) return;
  const meta = container.querySelector(".meta");
  if (!meta) return;
  const chip = document.createElement("span");
  chip.className = "llm-chip";
  chip.textContent = "LLM";
  chip.title =
    elapsedMs != null
      ? `Respuesta reescrita por LLaMA (${(elapsedMs / 1000).toFixed(1)} s)`
      : "Respuesta reescrita por LLaMA";
  meta.appendChild(document.createTextNode(" "));
  meta.appendChild(chip);
}

// Normaliza el texto para detectar marcas de LLM
function stripLLMMarks(text) {
  if (!text) return { clean: "", used: false };
  let used = false;
  let clean = text;

  const marks = [/\s*✨LLM\s*$/i, /\s*\(Redactado por LLaMA\)\s*$/i];

  for (const rx of marks) {
    if (rx.test(clean)) {
      used = true;
      clean = clean.replace(rx, "").trim();
    }
  }
  return { clean, used };
}

/* ==========================================================
 * ========== “✨ …Pensando…” (badge + cronómetro) ==========
 * ========================================================== */

let thinkingHandle = null;

// Crea el badge y devuelve función para detenerlo.
function startThinking() {
  const log = logEl();
  if (!log) return () => {};

  const node = document.createElement("div");
  node.className = "msg loading";
  node.innerHTML = `
    <div class="meta">Asistente · ${nowStamp()}</div>
    <div class="thinking-badge" aria-live="polite">
      <span class="sparkle" aria-hidden="true">✨</span>
      <span class="dots" aria-hidden="true"></span>
      <span class="sr-only">Pensando…</span>
      <span> Pensando… </span>
      <span class="timer" data-mode="live">0.0 s</span>
    </div>`;
  log.appendChild(node);

  settleChatView(false);

  const t0 = performance.now();
  const timerEl = node.querySelector(".timer");
  const thinkingEl = node.querySelector(".thinking-badge");

  const id = setInterval(() => {
    if (!timerEl) return;
    const s = (performance.now() - t0) / 1000;
    timerEl.textContent = `${s.toFixed(1)} s`;
  }, 100);

  thinkingHandle = { id, t0, timerEl, thinkingEl };

  // función stop
  return (meta = null) => {
    if (!thinkingHandle) return;
    const { id, t0, timerEl, thinkingEl } = thinkingHandle;
    clearInterval(id);

    let totalMs = Math.round(performance.now() - t0);
    const spent = meta?.budget?.spent_ms;
    if (typeof spent === "number" && isFinite(spent) && spent >= 0)
      totalMs = spent;

    const totalTxt = (totalMs / 1000).toFixed(1);

    const llmMs = meta?.llm?.elapsed_ms;
    const suffix =
      typeof llmMs === "number" && isFinite(llmMs)
        ? ` · LLM: ${(llmMs / 1000).toFixed(1)} s`
        : "";

    if (timerEl) {
      timerEl.dataset.mode = "fixed";
      timerEl.textContent = `Listo · ${totalTxt} s${suffix}`;
    }
    if (thinkingEl) {
      thinkingEl.dataset.mode = "fixed";
    }

    thinkingHandle = null;
  };
}

/* =====================================
 * ========== llamada /ask =============
 * ===================================== */

// Envía texto o forceId al backend y renderiza la respuesta
// Acepta 'action' como string o como objeto { action/name/type, id, payload... }
async function enviarPregunta(pregunta, forceId = null, action = null) {
  if (!(pregunta && pregunta.trim()) && !forceId) return;
  if (window.chatBusy) return;         // antiespam
  window.chatBusy = true;

  // Mostrar lo que escribió el usuario (no duplicar si es acción)
  if (forceId === null && pregunta?.trim()) {
    agregarMensaje(escapeHtml(pregunta), "me");
  }

  const stopThinking = startThinking();
  let measuredMs = 0;

  try {
    const t0 = performance.now();

    const body = {};
    if (pregunta) body.pregunta = pregunta;
    if (forceId) body.forceId = forceId;

    if (action) {
      if (typeof action === "string") {
        body.action = action;
      } else if (typeof action === "object") {
        body.action = action.action || action.name || action.type || "summarize";
        if (action.id) body.forceId = action.id; // por si vino dentro del objeto
        if (action.payload) body.payload = action.payload; // ej: { action_prompt: "..." }
      }
    }

    const r = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }

    measuredMs = performance.now() - t0;
    stopThinking(data?.meta || { budget: { spent_ms: measuredMs } });

    if (!r.ok) {
      const msg =
        data?.mensaje ||
        (r.status === 503
          ? "El servicio de embeddings está temporalmente no disponible. Probá de nuevo en unos segundos."
          : `No pude procesar tu consulta (HTTP ${r.status}).`);
      agregarMensaje(escapeHtml(msg), "bot");
      return;
    }

    // === DESAMBIGUACIÓN (UNA SOLA LEYENDA) ===
    if (data?.need_choice && Array.isArray(data.options)) {
      renderDocChoices(data.mensaje || "Encontré varias opciones parecidas. Elegí una:");
      renderDocChoicesList(data.pregunta || pregunta, data.options);
      return;
    }

    // Respuesta directa
    let respuesta = String(data?.respuesta || "");
    const { clean, used } = stripLLMMarks(respuesta);
    respuesta = clean;

    const nodo = agregarMensaje(
      `<div>${escapeHtml(respuesta).replace(/\n/g, "<br/>")}</div>`,
      "bot"
    );

    // Chapita LLM si corresponde
    const llmUsed = used || Boolean(data?.meta?.llm?.used);
    if (llmUsed) {
      const llmElapsed =
        typeof data?.meta?.llm?.elapsed_ms === "number"
          ? data.meta.llm.elapsed_ms
          : null;
      addLLMBadge(nodo, llmElapsed);
    }

    // Feedback
    renderFeedback(nodo, data?.pregunta || pregunta, respuesta);

    // Acciones sugeridas
    if (Array.isArray(data?.meta?.actions) && data.meta.actions.length) {
      renderActions(nodo, data.meta.actions, data?.pregunta || pregunta);
    }

    settleChatView(true);
  } catch (e) {
    stopThinking({ budget: { spent_ms: measuredMs } });
    console.error("Error en /ask:", e);
    agregarMensaje(
      "⚠️ No se pudo conectar con el servidor o el servicio de embeddings. Verificá que ambos estén en ejecución.",
      "error"
    );
  } finally {
    window.chatBusy = false;           // libera bloqueo
  }
}

/* ======================================
 * ========== desambiguación ============
 * ====================================== */

function selectThisAndHideSiblings(btn) {
  btn.classList.add("chosen");
  btn.parentElement.querySelectorAll(".choice-btn").forEach((b) => {
    if (b !== btn) {
      b.classList.add("fade-out");
      setTimeout(() => b.remove(), 280);
    }
  });
}

// Muestra la leyenda UNA sola vez
function renderDocChoices(messageText) {
  const nodo = agregarMensaje(escapeHtml(messageText), "bot");
  const wrap = document.createElement("div");
  wrap.className = "choice-wrap";
  nodo.appendChild(wrap);
  nodo._choicesContainer = wrap;
  requestAnimationFrame(() => settleChatView(true));
}

// Dibuja las tarjetas de opciones dentro del último bloque creado
function renderDocChoicesList(_pregunta, options) {
  const wraps = document.querySelectorAll(".choice-wrap");
  const wrap = wraps[wraps.length - 1] || null;
  if (!wrap) return;

  for (const opt of options) {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.innerHTML = `
      <div class="choice-title">${escapeHtml(opt.title)}</div>
      <div class="choice-date">${opt.date ? formatDate(opt.date) : ""}</div>
      <div class="choice-prev">${escapeHtml(
        (opt.preview || "").replace(/\n/g, " ")
      ).slice(0, 160)}</div>
    `;
    btn.addEventListener("click", async () => {
      selectThisAndHideSiblings(btn);
      agregarMensaje(`Abrir: ${escapeHtml(opt.title)}`, "me");
      await enviarPregunta("", opt.id); // forceId
    });
    wrap.appendChild(btn);
  }
}

/* =======================================
 * ========== feedback (pulgares) =========
 * ======================================= */

function renderFeedback(container, pregunta, respuesta) {
  const fb = document.createElement("div");
  fb.className = "feedback";
  fb.innerHTML = `
    <span class="fb-label">¿Te sirvió la respuesta?</span>
    <button class="fb-btn fb-up" title="Pulgar arriba" aria-label="Pulgar arriba">👍</button>
    <button class="fb-btn fb-down" title="Pulgar abajo" aria-label="Pulgar abajo">👎</button>
    <span class="fb-status" aria-live="polite"></span>
  `;
  container.appendChild(fb);

  const up = fb.querySelector(".fb-up");
  const down = fb.querySelector(".fb-down");
  const status = fb.querySelector(".fb-status");

  const lockVoting = (ok) => {
    up.disabled = true;
    down.disabled = true;
    up.setAttribute("aria-disabled", "true");
    down.setAttribute("aria-disabled", "true");
    if (ok) {
      status.textContent = "¡Gracias!";
      status.classList.add("ok-green"); // ← verde
    }
  };

  const send = async (pulgar) => {
    try {
      status.textContent = "Enviando…";
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pulgar, pregunta, respuesta }),
      });
      if (r.ok) {
        lockVoting(true);
      } else {
        status.textContent = "No se pudo guardar.";
      }
    } catch {
      status.textContent = "No se pudo guardar.";
    }
  };

  up.onclick = () => send("up");
  down.onclick = () => send("down");
}

/* ======================================
 * ========== acciones (resumen) =========
 * ====================================== */

// Pasa el objeto de acción al backend, agregando un action_prompt por defecto
function renderActions(container, actions) {
  if (!Array.isArray(actions) || !actions.length) return;

  const bar = document.createElement("div");
  bar.className = "action-bar";

  const label = document.createElement("span");
  label.className = "action-hint";
  label.textContent = "¿Querés un resumen con LLaMA?";
  bar.appendChild(label);

  for (const a of actions) {
    const kind = a?.type || a?.action || a?.name || "";
    if (String(kind).toLowerCase().includes("summar")) {
      const btn = document.createElement("button");
      btn.className = "action-btn";
      btn.textContent = a.label || "Resumir con LLaMA";

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = "Resumiendo… ✨";
        agregarMensaje("Resumir con LLaMA", "me");

        const defaultPrompt =
          "Resumilo en 3 a 5 líneas claras para público general. " +
          "Usá saltos de línea (sin viñetas ni numeración), español neutro, " +
          "solo hechos: idea central + 2 datos clave (fechas/lugares).";

        const actionObj = {
          ...a,
          action: kind || "summarize",
          id: a.id,
          payload: {
            ...(a.payload || {}),
            action_prompt: a.payload?.action_prompt || defaultPrompt,
          },
        };

        await enviarPregunta("", a.id, actionObj);
        bar.remove();
        // btn.textContent = original; btn.disabled = false; // si preferís dejar la barra
      });

      bar.appendChild(btn);
    }
  }

  container.appendChild(bar);
  requestAnimationFrame(() => settleChatView(true));
}

/* ======================================
 * ========== minimizar chat =============
 * ====================================== */

function setChatMinimized(min) {
  const chat = document.querySelector(".chat");
  const fab  = document.getElementById("chat-fab");
  const btn  = document.getElementById("chat-min-btn");
  if (!chat || !fab || !btn) return;

  if (min) {
    chat.classList.add("hidden");
    chat.setAttribute("aria-hidden","true");
    chat.setAttribute("inert","");               // evita foco/scroll dentro
    fab.style.display = "inline-flex";
    btn.textContent = "+";
    document.body.classList.add("chat-min");
  } else {
    chat.classList.remove("hidden");
    chat.removeAttribute("aria-hidden");
    chat.removeAttribute("inert");
    fab.style.display = "none";
    btn.textContent = "—";
    document.body.classList.remove("chat-min");
    settleChatView(true);
    document.getElementById("chat-input")?.focus();
  }
}


function initMinimizeUI() {
  const btn = document.getElementById("chat-min-btn");
  const fab = document.getElementById("chat-fab");
  if (!btn || !fab) return;

  // Estado inicial: si es pantalla chica, arrancá minimizado
  const mq = window.matchMedia("(max-width: 979px)");
  setChatMinimized(mq.matches);

  // Cuando cambia el ancho de pantalla, sincronizá el estado
  mq.addEventListener("change", (e) => setChatMinimized(e.matches));

  // Botón de minimizar/maximizar en el header
  btn.addEventListener("click", () => {
    const isHidden = document.querySelector(".chat")?.classList.contains("hidden");
    setChatMinimized(!isHidden);
  });

  // FAB abre el chat (y pausa la animación automáticamente)
  fab.addEventListener("click", () => setChatMinimized(false));
}


/* ======================================
 * ========== Resize Grip ================
 * ====================================== */

function initResizeGrip() {
  const chat = document.querySelector(".chat");
  if (!chat) return;

  // crea el grip si no existe
  let grip = chat.querySelector(".chat-resize-grip");
  if (!grip) {
    grip = document.createElement("div");
    grip.className = "chat-resize-grip";
    chat.appendChild(grip);
  }

  let dragging = false,
    startX = 0,
    startY = 0,
    startW = 0,
    startH = 0;

  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    const r = chat.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startW = r.width;
    startH = r.height;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    chat.style.width = Math.max(360, startW + dx) + "px";
    chat.style.height = Math.max(420, startH + dy) + "px";
  }

  function onUp() {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
}

/* ===========================
 * ========== init ===========
 * =========================== */

function initChat() {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const btn = document.getElementById("chat-btn");
  const log = logEl();
  if (!form || !input || !btn || !log) return;

  // cortar scroll chaining del área de mensajes
  log.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
    },
    { passive: true }
  );

  // cancelar anclas con href="#"
  document.querySelectorAll('a[href="#"]').forEach((a) => {
    a.addEventListener("click", (e) => e.preventDefault());
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    settleChatView(true);
    enviarPregunta(q).finally(() => (btn.disabled = false));
    input.value = "";
    input.focus();
  });

  // Enviar con Ctrl/Cmd + Enter
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  // Fade-in suave para cada mensaje nuevo
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach((node) => {
          if (node.classList?.contains("msg")) {
            node.style.opacity = 0;
            node.style.transition = "opacity 0.4s ease";
            requestAnimationFrame(() => (node.style.opacity = 1));
          }
        });
      }
    }
  });
  observer.observe(log, { childList: true });
}

// Arranque de la UI
pintarTimeline();
initChat();
initMinimizeUI();
initResizeGrip();
