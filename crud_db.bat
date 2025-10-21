@echo off
title 🏛️ Museo Asistente - CRUD + Embeddings
color 0A

REM === 1️⃣ Activar entorno virtual ===
call venv\Scripts\activate

REM === 2️⃣ Ejecutar CRUD principal ===
echo.
echo 🚀 Iniciando interfaz CRUD de conocimiento...
python crud_conocimiento.py

REM === 3️⃣ Generar embeddings automáticamente ===
echo.
echo 🧩 Generando vectores locales (seed_local_embeddings.py)...
python seed_local_embeddings.py

REM === 4️⃣ Confirmación visual ===
echo.
echo ✅ Proceso completado correctamente.
echo Los registros de la tabla 'conocimiento' ahora deberían tener vectores asociados.
echo.

REM === 5️⃣ Mantener la ventana abierta ===
pause
