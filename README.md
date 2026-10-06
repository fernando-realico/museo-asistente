# Asistente Conversacional Accesible – Museo Histórico de Realicó

Proyecto desarrollado durante la **Práctica Profesional de la Licenciatura en Inteligencia Artificial y Robótica – Universidad Siglo 21**.

## Descripción

Asistente conversacional para consulta de información histórica del Museo Histórico de Realicó.

El proyecto comenzó como un chatbot basado en **RAG y búsqueda semántica** y posteriormente evolucionó hacia una interfaz conversacional por voz, orientada a mejorar la accesibilidad y permitir una interacción más natural con la información.

## Objetivo

Facilitar el acceso autónomo a información histórica, contemplando especialmente a personas con discapacidad visual, dificultades de lectura, limitaciones motrices o situaciones donde la interacción mediante teclado resulte incómoda.

## Arquitectura y tecnologías

- **Node.js / JavaScript** – backend lógico e interfaz web.
- **Python / Flask** – microservicios de inteligencia artificial.
- **MySQL** – persistencia de información.
- **Embeddings y búsqueda vectorial** – recuperación semántica de contexto.
- **RAG** – generación de respuestas basada en información recuperada.
- **Vosk** – reconocimiento de voz / Speech-to-Text (STT).
- **Piper** – síntesis de voz / Text-to-Speech (TTS).
- **FFmpeg** – procesamiento y normalización de audio.

## Funcionamiento

El usuario puede realizar una consulta por voz. El sistema:

1. captura y normaliza el audio;
2. convierte la voz a texto mediante Vosk;
3. recupera información relevante mediante búsqueda semántica;
4. genera la respuesta correspondiente;
5. transforma la respuesta nuevamente en audio mediante Piper.

## Evidencias del proyecto

**Demo en video y presentación técnica:**  
[Ver carpeta en Google Drive](https://drive.google.com/drive/folders/1Ht7ImPxIU34aC0Egr351vegTw-40yUFt?usp=sharing)

## Contexto académico

Proyecto realizado en el marco de la **Práctica Profesional de Inteligencia Artificial y Robótica**, con acompañamiento académico del **Ing. Marcelo Griotti**.

El desarrollo permitió trabajar sobre integración de software, inteligencia artificial, recuperación semántica, microservicios, procesamiento de audio y accesibilidad.

---

**Jorge Fernando Gutierrez**  
Licenciatura en Inteligencia Artificial y Robótica  
[LinkedIn](https://www.linkedin.com/in/fernando-gutierrez-a36279179)
