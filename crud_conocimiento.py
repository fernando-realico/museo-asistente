# crud_conocimiento.py
# CRUD de la tabla "conocimiento" + utilidades de sincronización JSON,
# y administración de la tabla "retroalimentacion" (pulgares del chat).

import json
import mysql.connector
from tabulate import tabulate
from colorama import Fore, Style, init
from datetime import date, datetime

# ===== Inicializar colorama =====
init(autoreset=True)

# ===== Configuración DB =====
DB = {
    "host": "localhost",
    "user": "museo",
    "password": "museo2025",
    "database": "museo"
}

def conectar():
    return mysql.connector.connect(**DB)

# ---------- Helpers ----------
def shorten(text, max_len=40):
    if text is None:
        return ""
    if isinstance(text, (date, datetime)):
        return text.isoformat()
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8", errors="ignore")
        except Exception:
            text = str(text)
    s = str(text)
    return s if len(s) <= max_len else s[:max_len//2] + "…" + s[-max_len//2:]

def safe_jsonify_value(v):
    """Deja el valor serializable por json: str/float/int/bool/None/list/dict"""
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="ignore")
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    # Fallback seguro
    return str(v)

def normalize_fecha(fe):
    """Devuelve fecha YYYY-MM-DD o None si no es válida."""
    if not fe:
        return None
    try:
        s = str(fe).strip()
        if len(s) >= 10:
            s = s[:10]
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except Exception:
        return None

# ---------- Exportar a noticias.json ----------
def exportar_a_json():
    """Exporta la tabla a noticias.json en formato {"news":[...]}, serializando seguro."""
    try:
        conn = conectar()
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT titulo, contenido, fecha_evento, imagen_url, etiquetas, fuente_url
            FROM conocimiento
            ORDER BY fecha_evento ASC
        """)
        rows = cur.fetchall()
        conn.close()

        # Normalizar a tipos JSON
        clean_rows = []
        for r in rows:
            clean_rows.append({
                "titulo":       safe_jsonify_value(r.get("titulo")),
                "contenido":    safe_jsonify_value(r.get("contenido")),
                "fecha_evento": safe_jsonify_value(r.get("fecha_evento")),
                "imagen_url":   safe_jsonify_value(r.get("imagen_url")),
                "etiquetas":    safe_jsonify_value(r.get("etiquetas")),
                "fuente_url":   safe_jsonify_value(r.get("fuente_url")),
            })

        with open("noticias.json", "w", encoding="utf-8") as f:
            json.dump({"news": clean_rows}, f, indent=2, ensure_ascii=False)

        print(Fore.YELLOW + "📝 noticias.json sincronizado." + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"❌ No pude exportar a noticias.json: {e}" + Style.RESET_ALL)

# ---------- Listar conocimiento (con estado de vector) ----------
def listar(resaltar_id=None):
    """
    Lista eventos mostrando si tienen vector y cuántas dimensiones (dims).
    Usamos JSON_LENGTH(vector) porque 'vector' es tipo JSON.
    """
    conn = conectar()
    cur = conn.cursor(dictionary=True)
    cur.execute("""
        SELECT
          id,
          titulo,
          contenido,
          fecha_evento,
          imagen_url,
          etiquetas,
          fuente_url,
          fecha_registro,
          COALESCE(JSON_LENGTH(vector), 0) AS dims   -- nº de floats en el embedding
        FROM conocimiento
        ORDER BY fecha_evento ASC, id ASC
    """)
    rows = cur.fetchall()
    conn.close()

    data = []
    for idx, r in enumerate(rows, 1):
        # ✔ si dims >= 64 (cualquier embedding real), ✖ si 0
        vec_ok = "✔" if (r["dims"] or 0) >= 64 else "✖"

        titulo_fmt = shorten(r["titulo"], 40)
        if resaltar_id and r["id"] == resaltar_id:
            titulo_fmt = Fore.GREEN + titulo_fmt + Style.RESET_ALL

        data.append([
            idx,                        # N°
            r["id"],                    # ID real
            vec_ok,                     # Estado vector
            r["dims"] or 0,             # Dimensiones (p.ej. 384)
            titulo_fmt,
            shorten(r["contenido"], 60),
            shorten(str(r["fecha_evento"])[:10], 10),
            shorten(r["imagen_url"], 50),
            shorten(r["etiquetas"], 30),
            shorten(r["fuente_url"], 60),
            shorten(r["fecha_registro"], 19),
        ])

    print(Fore.CYAN + "\n━━━ 📜 Eventos en la tabla conocimiento ━━━" + Style.RESET_ALL)
    print(tabulate(
        data,
        headers=["N°", "ID", "Vec", "Dims", "Título", "Contenido", "Fecha", "Imagen", "Etiquetas", "Fuente", "Registro"],
        tablefmt="fancy_grid"
    ))

# ---------- Listar SOLO los que NO tienen vector ----------
def listar_sin_vector():
    """Muestra filas sin embedding (útil para debug del seed)."""
    conn = conectar()
    cur = conn.cursor(dictionary=True)
    cur.execute("""
        SELECT
          id,
          titulo,
          DATE_FORMAT(fecha_evento, '%Y-%m-%d') AS fecha,
          COALESCE(JSON_LENGTH(vector), 0) AS dims
        FROM conocimiento
        WHERE vector IS NULL
           OR JSON_LENGTH(vector) = 0
        ORDER BY fecha_evento ASC, id ASC
    """)
    rows = cur.fetchall()
    conn.close()

    if not rows:
        print(Fore.GREEN + "✅ Todas las filas tienen vector." + Style.RESET_ALL)
        return

    data = []
    for r in rows:
        data.append([r["id"], shorten(r["titulo"], 50), r["fecha"], r["dims"]])
    print(Fore.YELLOW + "\n⚠️ Filas sin vector" + Style.RESET_ALL)
    print(tabulate(data, headers=["ID", "Título", "Fecha", "Dims"], tablefmt="fancy_grid"))

# ---------- Crear ----------
def crear():
    try:
        conn = conectar()
        cur = conn.cursor()

        print(Fore.CYAN + "\n=== ➕ Crear nuevo evento ===" + Style.RESET_ALL)
        titulo    = input("Título: ")
        contenido = input("Contenido: ")
        fecha     = normalize_fecha(input("Fecha (YYYY-MM-DD): "))
        imagen    = input("URL Imagen: ")
        etiquetas = input("Etiquetas: ")
        fuente    = input("Fuente URL: ")

        # Guardamos vector = NULL (no '[]') para que sea claro que falta seed.
        sql = """INSERT INTO conocimiento
                 (titulo, contenido, fecha_evento, imagen_url, etiquetas, fuente_url, vector)
                 VALUES (%s, %s, %s, %s, %s, %s, NULL)"""
        cur.execute(sql, (titulo, contenido, fecha, imagen, etiquetas, fuente))
        conn.commit()
        nuevo_id = cur.lastrowid
        print(Fore.GREEN + f"✅ Evento creado con ID {nuevo_id}" + Style.RESET_ALL)
        conn.close()

        exportar_a_json()
        listar(resaltar_id=nuevo_id)
    except Exception as e:
        print(Fore.RED + f"❌ Error creando evento: {e}" + Style.RESET_ALL)

# ---------- Modificar ----------
def modificar():
    listar()
    id_sel = input("\nIngrese ID REAL a modificar (columna ID): ").strip()
    if not id_sel.isdigit():
        print(Fore.RED + "❌ ID inválido" + Style.RESET_ALL)
        return
    id_sel = int(id_sel)

    try:
        conn = conectar()
        cur = conn.cursor()
        cur.execute("""SELECT titulo, contenido, fecha_evento, imagen_url, etiquetas, fuente_url
                       FROM conocimiento WHERE id=%s""", (id_sel,))
        row = cur.fetchone()

        if not row:
            print(Fore.RED + "❌ No se encontró ese ID" + Style.RESET_ALL)
            conn.close()
            return

        print(Fore.CYAN + "\n✏️ Valores actuales (Enter para dejar igual):" + Style.RESET_ALL)
        t, c, f, i, e, fu = row
        titulo    = input(f"Título [{t}]: ") or t
        contenido = input(f"Contenido [{shorten(c,50)}]: ") or c
        fecha_in  = input(f"Fecha (YYYY-MM-DD) [{f}]: ").strip()
        fecha     = normalize_fecha(fecha_in) or f
        imagen    = input(f"Imagen URL [{i}]: ") or i
        etiquetas = input(f"Etiquetas [{e}]: ") or e
        fuente    = input(f"Fuente URL [{fu}]: ") or fu

        sql = """UPDATE conocimiento
                 SET titulo=%s, contenido=%s, fecha_evento=%s, imagen_url=%s, etiquetas=%s, fuente_url=%s
                 WHERE id=%s"""
        cur.execute(sql, (titulo, contenido, fecha, imagen, etiquetas, fuente, id_sel))
        conn.commit()
        conn.close()

        print(Fore.GREEN + "✅ Evento actualizado" + Style.RESET_ALL)
        exportar_a_json()
        listar(resaltar_id=id_sel)
    except Exception as e:
        print(Fore.RED + f"❌ Error modificando: {e}" + Style.RESET_ALL)

# ---------- Eliminar (uno) ----------
def eliminar():
    listar()
    id_sel = input("\nIngrese ID REAL a eliminar (columna ID): ").strip()
    if not id_sel.isdigit():
        print(Fore.RED + "❌ ID inválido" + Style.RESET_ALL)
        return
    id_sel = int(id_sel)

    confirm = input(Fore.YELLOW + f"⚠️ Seguro que querés eliminar el ID {id_sel}? (s/n): " + Style.RESET_ALL)
    if confirm.lower() != "s":
        print(Fore.RED + "❌ Cancelado" + Style.RESET_ALL)
        return

    try:
        conn = conectar()
        cur = conn.cursor()
        cur.execute("DELETE FROM conocimiento WHERE id=%s", (id_sel,))
        conn.commit()
        affected = cur.rowcount
        conn.close()

        if affected:
            print(Fore.GREEN + f"✅ Evento ID {id_sel} eliminado" + Style.RESET_ALL)
        else:
            print(Fore.YELLOW + f"ℹ️ No había un evento con ID {id_sel}" + Style.RESET_ALL)

        exportar_a_json()
        listar()
    except Exception as e:
        print(Fore.RED + f"❌ Error eliminando: {e}" + Style.RESET_ALL)

# --- Importar JSON -> tabla (upsert por título) ---
def importar_desde_json():
    try:
        # 1) Cargar payload desde noticias.json (formato {"news":[...]})
        with open("noticias.json", "r", encoding="utf-8") as f:
            payload = json.load(f)
        items = payload.get("news", [])

        conn = conectar()
        cur  = conn.cursor()

        # 2) Sentencias SQL (vector = NULL para marcar que falta calcular embedding)
        ins = """INSERT INTO conocimiento
                 (titulo, contenido, fecha_evento, imagen_url, etiquetas, fuente_url, vector)
                 VALUES (%s, %s, %s, %s, %s, %s, NULL)"""
        upd = """UPDATE conocimiento
                 SET contenido=%s, fecha_evento=%s, imagen_url=%s, etiquetas=%s, fuente_url=%s
                 WHERE id=%s"""
        sel = "SELECT id FROM conocimiento WHERE titulo=%s"

        # 3) Upsert por título
        created, updated = 0, 0
        for it in items:
            t  = it.get("titulo", "").strip()
            c  = it.get("contenido", "")
            fe = normalize_fecha(it.get("fecha_evento"))
            im = it.get("imagen_url", "")
            et = it.get("etiquetas", "")
            fu = it.get("fuente_url", "")

            if not t:
                continue

            cur.execute(sel, (t,))
            row = cur.fetchone()
            if row:
                cur.execute(upd, (c, fe, im, et, fu, row[0]))
                updated += 1
            else:
                cur.execute(ins, (t, c, fe, im, et, fu))
                created += 1

        conn.commit()
        conn.close()

        # 4) Feedback y sincronización de archivo
        print(Fore.GREEN + f"✅ Importado desde JSON. Nuevos: {created}, Actualizados: {updated}" + Style.RESET_ALL)
        exportar_a_json()   # normaliza salida
        listar()

        # 5) Generar embeddings automáticamente
        #    (requiere que el venv esté activo y que seed_local_embeddings.py exista en el cwd)
        import subprocess, sys
        print(Fore.YELLOW + "\n🧩 Generando vectores locales con seed_local_embeddings.py ..." + Style.RESET_ALL)
        try:
            # Usa el mismo intérprete con el que está corriendo el CRUD (más robusto que 'python' a secas)
            subprocess.run([sys.executable, "seed_local_embeddings.py"], check=True)
            print(Fore.GREEN + "✅ Vectores generados correctamente.\n" + Style.RESET_ALL)
        except subprocess.CalledProcessError as e:
            print(Fore.RED + f"❌ Error al generar vectores (exit {e.returncode}). Revisá la consola del seed." + Style.RESET_ALL)
        except FileNotFoundError:
            print(Fore.RED + "❌ No se encontró seed_local_embeddings.py en el directorio actual." + Style.RESET_ALL)

    except FileNotFoundError:
        print(Fore.RED + "❌ No encontré noticias.json" + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"❌ Error importando JSON: {e}" + Style.RESET_ALL)

# ---------- Eliminar TODO conocimiento ----------
def eliminar_todo():
    confirm = input(Fore.RED + "⚠️ Esto eliminará TODOS los eventos de la tabla conocimiento. ¿Estás seguro? (s/n): " + Style.RESET_ALL)
    if confirm.lower() != "s":
        print(Fore.YELLOW + "❌ Cancelado" + Style.RESET_ALL)
        return

    try:
        conn = conectar()
        cur = conn.cursor()
        cur.execute("DELETE FROM conocimiento")   # Borra todos los registros
        conn.commit()
        conn.close()

        print(Fore.GREEN + "✅ Todos los eventos fueron eliminados." + Style.RESET_ALL)

        # Exportar JSON vacío
        with open("noticias.json", "w", encoding="utf-8") as f:
            json.dump({"news": []}, f, indent=2, ensure_ascii=False)
        print(Fore.YELLOW + "📝 noticias.json también fue limpiado." + Style.RESET_ALL)

    except Exception as e:
        print(Fore.RED + f"❌ Error al eliminar todos los eventos: {e}" + Style.RESET_ALL)

# ======================================================================
# === Retroalimentación (pulgares) =====================================
# Tabla: retroalimentacion(id, fecha_creacion, pulgar, pregunta, respuesta, ip_cliente, agente_usuario)

def retro_listar(limit=50, offset=0):
    """Lista retroalimentación con paginado simple."""
    try:
        conn = conectar()
        cur = conn.cursor()
        cur.execute("""
            SELECT id, fecha_creacion, pulgar, LEFT(pregunta,200), LEFT(respuesta,200), ip_cliente
            FROM retroalimentacion
            ORDER BY fecha_creacion DESC
            LIMIT %s OFFSET %s
        """, (limit, offset))
        rows = cur.fetchall()
        conn.close()

        data = []
        for (id_, fecha, pulgar, pregunta, respuesta, ip) in rows:
            data.append([
                id_,
                shorten(str(fecha), 19),
                pulgar,
                shorten(pregunta, 60),
                shorten(respuesta, 60),
                shorten(ip, 18)
            ])

        print(Fore.MAGENTA + "\n━━━ 📊 Retroalimentación (más recientes primero) ━━━" + Style.RESET_ALL)
        print(tabulate(
            data,
            headers=["ID", "Fecha", "Pulgar", "Pregunta", "Respuesta", "IP"],
            tablefmt="fancy_grid"
        ))
        print(Fore.MAGENTA + f"Mostrando hasta {limit} registros (offset {offset})." + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"❌ Error listando retroalimentación: {e}" + Style.RESET_ALL)

def retro_eliminar_por_id():
    """Borra un registro puntual por ID."""
    try:
        id_txt = input("ID de retroalimentación a eliminar: ").strip()
        if not id_txt.isdigit():
            print(Fore.RED + "❌ ID inválido" + Style.RESET_ALL)
            return
        id_sel = int(id_txt)

        conn = conectar()
        cur  = conn.cursor()
        cur.execute("DELETE FROM retroalimentacion WHERE id=%s", (id_sel,))
        conn.commit()
        n = cur.rowcount
        conn.close()

        if n:
            print(Fore.GREEN + f"✅ Retroalimentación ID {id_sel} eliminada." + Style.RESET_ALL)
        else:
            print(Fore.YELLOW + f"ℹ️ No existía un registro con ID {id_sel}." + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"❌ Error eliminando retroalimentación: {e}" + Style.RESET_ALL)

def retro_limpiar_todo():
    """Elimina TODOS los registros de retroalimentación."""
    confirm = input(Fore.RED + "⚠️ Esto eliminará TODA la retroalimentación. ¿Seguro? (s/n): " + Style.RESET_ALL)
    if confirm.lower() != "s":
        print(Fore.YELLOW + "❌ Cancelado" + Style.RESET_ALL)
        return
    try:
        conn = conectar()
        cur  = conn.cursor()
        cur.execute("TRUNCATE TABLE retroalimentacion")
        conn.commit()
        conn.close()
        print(Fore.GREEN + "✅ Tabla retroalimentacion vaciada." + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"❌ Error vaciando retroalimentación: {e}" + Style.RESET_ALL)

def menu_retro():
    """Submenú para administrar retroalimentación."""
    while True:
        print(Fore.MAGENTA + "\n=== 📊 Retroalimentación ===" + Style.RESET_ALL)
        print("1. Listar últimos 50")
        print("2. Listar con límite y offset")
        print("3. Eliminar por ID")
        print("4. ⚠️ Vaciar toda la tabla")
        print("0. Volver")
        op = input("Opción: ").strip()
        if op == "1":
            retro_listar(50, 0)
        elif op == "2":
            try:
                limit  = int(input("Límite (ej. 100): ").strip() or "50")
                offset = int(input("Offset (ej. 0): ").strip() or "0")
            except:
                print(Fore.RED + "Valores inválidos." + Style.RESET_ALL)
                continue
            retro_listar(limit, offset)
        elif op == "3":
            retro_eliminar_por_id()
        elif op == "4":
            retro_limpiar_todo()
        elif op == "0":
            break
        else:
            print(Fore.RED + "❌ Opción inválida" + Style.RESET_ALL)

# ======================================================================

# --- Menú principal ---
def menu():
    while True:
        print(Fore.CYAN + "\n=== 🎛️ CRUD Museo ===" + Style.RESET_ALL)
        print("1. Listar eventos")
        print("2. Crear nuevo evento")
        print("3. Modificar evento")
        print("4. Eliminar evento")
        print("5. Exportar JSON ahora")
        print("6. Importar desde JSON → Tabla")
        print("7. ⚠️ Eliminar TODOS los eventos")
        print("8. 📊 Retroalimentación (pulgares)")
        print("9. 🔍 Ver filas SIN vector")            # <— NUEVO
        print("0. Salir")
        op = input("Seleccione opción: ").strip()

        try:
            if   op == "1": listar()
            elif op == "2": crear()
            elif op == "3": modificar()
            elif op == "4": eliminar()
            elif op == "5": exportar_a_json()
            elif op == "6": importar_desde_json()
            elif op == "7": eliminar_todo()
            elif op == "8": menu_retro()
            elif op == "9": listar_sin_vector()       # <— NUEVO
            elif op == "0":
                print(Fore.CYAN + "👋 Saliendo del CRUD Museo..." + Style.RESET_ALL)
                break
            else:
                print(Fore.RED + "❌ Opción inválida" + Style.RESET_ALL)
        except Exception as e:
            print(Fore.RED + f"💥 Error inesperado: {e}" + Style.RESET_ALL)

if __name__ == "__main__":
    menu()
