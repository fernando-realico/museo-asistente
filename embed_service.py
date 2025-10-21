# embed_service.py
# ======================================================================
# Servicio HTTP local (Flask) que convierte texto(s) -> embedding(s).
# El backend Node llama a: POST http://127.0.0.1:5001/embed
#   - Entrada (uno):
#       { "text": "¿Cuándo se fundó Realicó?" }
#     Salida:
#       { "embedding": [0.123, -0.045, ...] }
#
#   - Entrada (batch):
#       { "texts": ["uno", "dos", "tres"], "batch_size": 16 }
#     Salida:
#       { "embeddings": [[...],[...],[...]] }
#
# Endpoints extra:
#   - GET /health  → estado y metadatos del modelo
#   - GET /dim     → dimensión del embedding
# ======================================================================

from flask import Flask, request, jsonify                 # Framework web y helpers JSON
from sentence_transformers import SentenceTransformer     # Carga de modelos de SentenceTransformers
import unicodedata                                        # Para normalización opcional de tildes
import traceback                                          # Para logs de errores legibles
import os                                                 # Para rutas del modelo y variables de entorno

# ----------------------------------------------------------------------
# Crear app Flask
# ----------------------------------------------------------------------
app = Flask(__name__)

# ----------------------------------------------------------------------
# Modelos: dejamos el anterior comentado y activamos el nuevo
# ----------------------------------------------------------------------
# 🔹 MODELO ANTERIOR (liviano, ~90 MB, 384 dims, inglés principalmente)
# RUTA_MODELO_LOCAL = r"C:\Proyectos\museo-asistente\models\all-MiniLM-L6-v2"

# 🔹 MODELO NUEVO (más preciso, ~1.1 GB, 768 dims, multilingüe incl. español)
#    Nota: podés sobrescribir esta ruta con la variable de entorno MODEL_PATH
RUTA_MODELO_LOCAL = os.environ.get(
    "MODEL_PATH",
    r"C:\Proyectos\museo-asistente\models\paraphrase-multilingual-mpnet-base-v2"
)

# ----------------------------------------------------------------------
# Archivos mínimos esperados dentro del modelo (verificación temprana)
# ----------------------------------------------------------------------
REQUERIDOS = ["modules.json", "config.json", "tokenizer.json", "model.safetensors"]
for nombre in REQUERIDOS:
    ruta = os.path.join(RUTA_MODELO_LOCAL, nombre)       # compone ruta absoluta
    if not os.path.exists(ruta):                         # si falta, aborta con error claro
        raise FileNotFoundError(
            f"[ERROR] Falta '{nombre}' en {RUTA_MODELO_LOCAL}. "
            f"Descargá el repositorio completo del modelo (Git LFS)."
        )

# ----------------------------------------------------------------------
# Carga del modelo (una sola vez al iniciar el servicio)
#  - local_files_only=True: evita intentos de descarga por internet
#  - Nota: SentenceTransformer selecciona CPU/GPU automáticamente si hay CUDA
# ----------------------------------------------------------------------
print(f"[INFO] Cargando modelo desde {RUTA_MODELO_LOCAL} ...")
model = SentenceTransformer(RUTA_MODELO_LOCAL, local_files_only=True)
EMBED_DIM = model.get_sentence_embedding_dimension()
print(f"[OK] Modelo cargado. Dimensión del embedding = {EMBED_DIM}")

# ----------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------
def strip_accents(s: str) -> str:
    """
    Quita tildes/diacríticos (útil para consultas muy cortas).
    Dejalo activado solo si lo necesitás; por defecto, no lo uso.
    """
    if not s:
        return s
    nfkd = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))

def clean_text(text: str, remove_accents: bool = False) -> str:
    """
    Normaliza espacios, recorta y opcionalmente quita tildes.
    """
    if not isinstance(text, str):
        return ""
    t = " ".join(text.split())               # colapsa espacios/line breaks
    return strip_accents(t) if remove_accents else t

def encode_texts(texts, batch_size: int = 16):
    """
    Codifica 1 o N textos a embeddings usando el modelo cargado.
    - batch_size controla memoria/velocidad en lotes.
    Devuelve:
      - lista de floats (1 texto) o lista de listas (N textos)
    """
    # SentenceTransformer.encode ya trunca a máx. tokens del modelo.
    # convert_to_numpy=True y luego .tolist() para JSON-friendly.
    try:
        vecs = model.encode(
            texts,
            batch_size=max(1, int(batch_size)),
            convert_to_numpy=True,
            show_progress_bar=False,     # evitamos barras en consola
            normalize_embeddings=False   # si quisieras normalizar L2, ponelo True
        ).tolist()
        return vecs
    except Exception as e:
        # Propagamos error con trace para registro
        raise RuntimeError(f"Fallo al codificar: {e}")

# ----------------------------------------------------------------------
# Endpoint: POST /embed
#   - Acepta { "text": "..." }  -> { "embedding": [...] }
#   - Acepta { "texts": [...] } -> { "embeddings": [[...], ...] }
#   - Campo opcional: batch_size (int)
# ----------------------------------------------------------------------
@app.route("/embed", methods=["POST"])
def embed():
    try:
        payload = request.get_json(force=True) or {}           # lee JSON (aunque falte header)
        batch_size = payload.get("batch_size", 16)              # batch para lotes

        # --- Caso 1: un solo texto ---
        if "text" in payload and payload["text"] is not None:
            text = clean_text(str(payload["text"]), remove_accents=False)
            if not text:
                return jsonify({"error": "Falta 'text' o está vacío."}), 400

            vec = encode_texts(text, batch_size=batch_size)    # devuelve lista de floats
            # encode_texts devuelve lista también para 1 texto; homogenizamos a vector
            if isinstance(vec, list) and len(vec) > 0 and isinstance(vec[0], list):
                vec = vec[0]
            return jsonify({"embedding": vec})

        # --- Caso 2: varios textos ---
        if "texts" in payload and isinstance(payload["texts"], list):
            # Limpieza mínima de cada string
            texts = [clean_text(str(x), remove_accents=False) for x in payload["texts"]]
            # Filtra vacíos (para no reventar encode)
            texts = [t for t in texts if t]
            if not texts:
                return jsonify({"error": "'texts' no contiene strings válidos."}), 400

            vecs = encode_texts(texts, batch_size=batch_size)  # lista de listas
            return jsonify({"embeddings": vecs})

        # Si no vino ni text ni texts → error de uso
        return jsonify({"error": "Debés enviar 'text' (string) o 'texts' (lista)."}), 400

    except Exception as e:
        # Devuelve error 500 con traza para facilitar depuración
        print("[/embed] Exception:", e)
        print(traceback.format_exc())
        return jsonify({"error": f"{e}"}), 500

# ----------------------------------------------------------------------
# Endpoint: GET /health  → chequeo rápido del servicio
# ----------------------------------------------------------------------
@app.route("/health", methods=["GET"])
def health():
    try:
        info = {
            "ok": True,
            "model_path": RUTA_MODELO_LOCAL,
            "embedding_dim": EMBED_DIM,
            "embed_url": "http://127.0.0.1:5001/embed"
        }
        return jsonify(info)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# ----------------------------------------------------------------------
# Endpoint: GET /dim  → devuelve solo la dimensión de embedding
# ----------------------------------------------------------------------
@app.route("/dim", methods=["GET"])
def dim():
    return jsonify({"embedding_dim": EMBED_DIM})

# ----------------------------------------------------------------------
# Arranque del servidor Flask
# ----------------------------------------------------------------------
if __name__ == "__main__":
    print("[INFO] Servicio de embeddings listo en http://127.0.0.1:5001")
    # host 127.0.0.1 → solo accesible localmente (loopback)
    app.run(host="127.0.0.1", port=5001)
