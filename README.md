# Tracking Contenedores — Servidor Proxy

Servidor proxy para rastrear contenedores marítimos en portales de navieras.

## Despliegue rápido en Railway (recomendado)

1. Ve a [railway.app](https://railway.app) y crea una cuenta gratuita
2. Click en **"New Project"** → **"Deploy from GitHub repo"**
3. Sube esta carpeta a un repositorio de GitHub, o usa **"Deploy from local"**
4. Railway detecta automáticamente el `package.json` y lo despliega
5. Te dará una URL como: `https://tu-proyecto.up.railway.app`
6. Copia esa URL y pégala en el dashboard HTML donde dice `PROXY_URL`

## Despliegue en Render (alternativa gratuita)

1. Ve a [render.com](https://render.com) y crea cuenta
2. New → Web Service → conecta tu repo de GitHub
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Te da una URL como: `https://tu-proyecto.onrender.com`

## Prueba local

```bash
npm install
npm start
```

Abre http://localhost:3001 para verificar.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/track/:carrier/:number` | Rastrear un contenedor en una naviera específica |
| GET | `/api/detect/:number` | Auto-detectar naviera por prefijo y rastrear |
| POST | `/api/track-bulk` | Rastrear múltiples contenedores de una vez |

### Ejemplos:

```
GET /api/track/MSC/MSMU6096259
GET /api/detect/MSMU6096259
POST /api/track-bulk
  Body: { "containers": [{ "number": "MSMU6096259", "carrier": "MSC" }] }
```
