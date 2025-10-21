# seed_local_embeddings.py
# ======================================================================
# ¿Qué hace este script?
# ----------------------------------------------------------------------
# • Lee un JSON (por defecto: noticias.json) con los ítems del corpus.
# • Carga un modelo local de SentenceTransformers (sin internet).
# • Para cada ítem construye UN texto:  "titulo. contenido Etiquetas: ... Temas: ..."
#   y genera un embedding (768D si usás mpnet multilingüe).
# • Guarda/actualiza en MySQL la fila con los metadatos y el vector
#   en formato JSON (columna `vector`), listo para que `index.js` lo use.
#
# Estrategia "Nivel A" (alineada con index.js):
# ----------------------------------------------------------------------
# - El texto a vectorizar incluye: título + contenido + etiquetas.
# - Las etiquetas se incorporan de forma legible y con un refuerzo suave
#   (dos menciones cortas) para que el embedding “fije” la temática,
#   sin sobreponderar.
# - No generamos embeddings separados: 1 doc = 1 embedding (simple).
#
# Compatibilidad con index.js:
# ----------------------------------------------------------------------
# - index.js asume que `vector` es un JSON con una lista de floats.
# - La búsqueda en Node compara la consulta embebida vs. estos vectores.
# - También aplica filtro léxico en título+contenido+etiquetas y un BONUS
#   leve por solapamiento (puede apagarse si lo deseás).
#
# Uso:
# ----------------------------------------------------------------------
#   python seed_local_embeddings.py \
#       --json noticias.json \
#       --model_dir "C:/Proyectos/museo-asistente/models/paraphrase-multilingual-mpnet-base-v2" \
#       --host localhost --user museo --password museo2025 --database museo \
#       --table conocimiento --wipe-vectors
# ======================================================================

import os                      # rutas/chequeos de archivos
import json                    # serializar a JSON
import argparse                # flags CLI
import mysql.connector         # cliente MySQL
from mysql.connector import errorcode
from sentence_transformers import SentenceTransformer  # embeddings locales

# ----------------- FLAGS (línea de comandos) -----------------
parser = argparse.ArgumentParser(description="Seeder de embeddings locales (MySQL).")
parser.add_argument("--json", default="noticias.json", help="Archivo JSON de entrada.")
parser.add_argument(
    "--model_dir",
    # Ajustá la ruta por defecto al modelo local (debe estar completo en disco)
    default=r"C:/Proyectos/museo-asistente/models/paraphrase-multilingual-mpnet-base-v2",
    help="Carpeta del modelo local (usar mpnet 768 para mejores resultados).",
)
parser.add_argument("--host", default="localhost", help="Host MySQL.")
parser.add_argument("--user", default="museo", help="Usuario MySQL.")
parser.add_argument("--password", default="museo2025", help="Password MySQL.")
parser.add_argument("--database", default="museo", help="Base de datos MySQL.")
parser.add_argument("--table", default="conocimiento", help="Tabla destino.")
parser.add_argument(
    "--wipe-vectors",
    action="store_true",
    help="Pone NULL en columna vector antes de regenerar (útil para limpiar 384→768).",
)
args = parser.parse_args()  # parseo de flags

# ----------------- CONFIG DB -----------------
DB_CFG = dict(
    host=args.host,         # host MySQL (por flag)
    user=args.user,         # usuario
    password=args.password, # password
    database=args.database, # base de datos
)

# ----------------- RUTAS -----------------
RUTA_JSON = args.json              # archivo JSON (por flag)
RUTA_MODELO_LOCAL = args.model_dir # carpeta del modelo (por flag)

# ----------------- Helpers de DB -----------------
def crear_conexion():
    """Abre y retorna una conexión MySQL (usa DB_CFG)."""
    return mysql.connector.connect(**DB_CFG)

# ----------------- Carga JSON -----------------
def cargar_json(ruta):
    """
    Lee el JSON y retorna la lista de noticias.
    Soporta dos formatos:
      - { "news": [...] }
      - [ ... ]
    """
    with open(ruta, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        noticias = data.get("news", [])
    else:
        noticias = data
    if not isinstance(noticias, list):
        raise ValueError("El JSON debe ser una lista o contener 'news' como lista.")
    return noticias

# ----------------- Carga modelo local -----------------
def cargar_modelo_local():
    """
    Carga el modelo SOLAMENTE desde disco (sin internet).
    Verifica archivos clave para fallar rápido si falta algo.
    """
    requeridos = ["modules.json", "config.json"]  # mínimos (podés exigir tokenizer/model.safetensors también)
    faltan = [p for p in requeridos if not os.path.exists(os.path.join(RUTA_MODELO_LOCAL, p))]
    if faltan:
        raise FileNotFoundError(
            "Faltan archivos del modelo en la ruta local.\n"
            f"Ruta: {RUTA_MODELO_LOCAL}\n"
            f"Faltantes: {faltan}\n"
            "Descargá TODO el modelo (Git LFS / Download ZIP) y descomprimí."
        )
    print(f"🔁 Cargando modelo local: {RUTA_MODELO_LOCAL}")
    modelo = SentenceTransformer(RUTA_MODELO_LOCAL, local_files_only=True)  # sin internet
    emb_dim = modelo.get_sentence_embedding_dimension()                     # ej.: 768 en mpnet
    print(f"✅ Modelo cargado. Dimensiones del embedding: {emb_dim}")
    return modelo, emb_dim

# ----------------- Construcción del TEXTO a vectorizar (Nivel A) -----------------
def build_text_for_embedding(item):
    """
    Arma el texto a embedir uniendo:
      - título
      - contenido
      - etiquetas (lista legible) + refuerzo suave “Temas: …”
    Esto ayuda a que el embedding “fije” la temática del doc.
    """
    # 1) Campos base con defensivo (evita None)
    titulo = (item.get("titulo") or "").strip()
    contenido = (item.get("contenido") or "").strip()
    etiquetas_raw = (item.get("etiquetas") or "").strip()

    # 2) Normalizar etiquetas (coma-separadas → lista limpia y deduplicada)
    tags = []
    if etiquetas_raw:
        tags = [t.strip().lower() for t in etiquetas_raw.split(",") if t.strip()]
        tags = list(dict.fromkeys(tags))  # dedup conservando orden

    # 3) Texto legible de etiquetas (si hay)
    etiquetas_texto = f" Etiquetas: {', '.join(tags)}." if tags else ""

    # 4) Refuerzo suave (breve) para no sobreponderar
    refuerzo = f" Temas: {', '.join(tags)}." if tags else ""

    # 5) Componer (un solo embedding por documento, simple y compatible)
    #    Agregamos puntos/espacios para dar señales de segmentación al modelo.
    texto = f"{titulo}. {contenido}{etiquetas_texto}{refuerzo}".strip()

    return texto

# ----------------- Embedding de un texto -----------------
def generar_embedding(modelo, texto):
    """Convierte texto en vector (list[float] JSON-serializable)."""
    vec = modelo.encode(texto)         # numpy array
    return [float(x) for x in vec]     # lo transformamos a lista de floats

# ----------------- UPSERT en MySQL -----------------
def upsert_noticia(cur, tabla, noticia, embedding_json):
    """
    Inserta o actualiza un registro en `tabla`.
    Guarda el vector como JSON (ej.: 768 floats si usás mpnet).
    """
    sql = f"""
    INSERT INTO {tabla}
      (titulo, contenido, vector, fecha_evento, imagen_url, etiquetas, fuente_url)
    VALUES
      (%s, %s, CAST(%s AS JSON), %s, %s, %s, %s)
    ON DUPLICATE KEY UPDATE
      contenido    = VALUES(contenido),
      vector       = VALUES(vector),
      fecha_evento = VALUES(fecha_evento),
      imagen_url   = VALUES(imagen_url),
      etiquetas    = VALUES(etiquetas),
      fuente_url   = VALUES(fuente_url);
    """
    params = (
        noticia.get("titulo"),
        noticia.get("contenido"),
        json.dumps(embedding_json),  # lista -> texto JSON
        noticia.get("fecha_evento"),
        noticia.get("imagen_url"),
        noticia.get("etiquetas"),
        noticia.get("fuente_url"),
    )
    cur.execute(sql, params)

# ----------------- Limpieza de vectores (opcional) -----------------
def wipe_vectors(cur, tabla):
    """Setea NULL en la columna vector (para limpiar 384→768 o regenerar todo)."""
    cur.execute(f"UPDATE {tabla} SET vector = NULL")

# ----------------- Main -----------------
def main():
    # 1) Cargar modelo
    try:
        modelo, emb_dim = cargar_modelo_local()
    except Exception as e:
        print("❌ No se pudo cargar el modelo local:", e)
        raise

    # 2) Leer JSON
    if not os.path.exists(RUTA_JSON):
        raise FileNotFoundError(f"No existe el archivo {RUTA_JSON}")
    print(f"📄 Leyendo JSON: {RUTA_JSON}")
    noticias = cargar_json(RUTA_JSON)

    # 3) Conectar DB
    conn = crear_conexion()
    cur = conn.cursor()

    try:
        # 3.a) (opcional) limpiar vectores previos
        if args.wipe_vectors:
            print("🧹 Limpiando columna 'vector' (NULL para todos los registros)…")
            wipe_vectors(cur, args.table)
            conn.commit()

        insertadas = 0
        actualizadas = 0

        # 4) Recorrer items y hacer UPSERT
        for n in noticias:
            # Validaciones mínimas
            titulo = (n.get("titulo") or "").strip()
            contenido = (n.get("contenido") or "").strip()
            if not titulo or not contenido:
                print("⚠️  Saltando item sin 'titulo' o 'contenido':", n)
                continue

            # Texto a embedir: título + contenido + etiquetas
            texto_embed = build_text_for_embedding(n)

            # Generar vector y subir a la tabla
            vec = generar_embedding(modelo, texto_embed)
            upsert_noticia(cur, args.table, n, vec)

            # Heurística para contabilizar inserts/updates
            if cur.rowcount == 1:
                insertadas += 1
                print(f"✅ Insertada: {titulo}")
            else:
                actualizadas += 1
                print(f"♻️  Actualizada: {titulo}")

        # 5) Confirmar cambios
        conn.commit()
        print(f"\n🎉 Listo. Insertadas: {insertadas} | Actualizadas: {actualizadas}")
        print(f"📏 Verificación sugerida en MySQL: JSON_LENGTH(vector) = {emb_dim}")

    except mysql.connector.Error as err:
        conn.rollback()
        if err.errno == errorcode.ER_ACCESS_DENIED_ERROR:
            print("❌ Error de acceso: revisá usuario/contraseña de MySQL.")
        elif err.errno == errorcode.ER_BAD_DB_ERROR:
            print("❌ La base de datos no existe (creá 'museo').")
        else:
            print("❌ Error MySQL:", err)
    except Exception as e:
        conn.rollback()
        print("❌ Error general:", e)
    finally:
        cur.close()
        conn.close()

# Punto de entrada
if __name__ == "__main__":
    main()
