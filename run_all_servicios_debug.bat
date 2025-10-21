@echo on
setlocal ENABLEEXTENSIONS

set "ROOT=C:\Proyectos\museo-asistente"
set "PYTHON=%ROOT%\venv\Scripts\python.exe"
set "LLM_EXE=%ROOT%\llama_cpp\llama-server.exe"
set "MODEL=%ROOT%\models\llama\llama.gguf"

echo ROOT= %ROOT%
echo PYTHON= %PYTHON%
echo LLM_EXE= %LLM_EXE%
echo MODEL= %MODEL%

if not exist "%PYTHON%" echo [ERROR] falta PYTHON & dir /b "%ROOT%\venv\Scripts"
if not exist "%LLM_EXE%" echo [ERROR] falta llama-server & dir /b "%ROOT%\llama_cpp"
if not exist "%MODEL%" echo [ERROR] falta modelo & dir /b "%ROOT%\models\llama"

start "Embeddings (Flask)" cmd /k cd /d "%ROOT%" ^& "%PYTHON%" embed_service.py
start "LLaMA server"       cmd /k cd /d "%ROOT%\llama_cpp" ^& "%LLM_EXE%" --model "%MODEL%" --ctx-size 2048 --threads 6 --n-gpu-layers 0 --port 8081
start "npm start"          cmd /k cd /d "%ROOT%" ^& npm start

pause
