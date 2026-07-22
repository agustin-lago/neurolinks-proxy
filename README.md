# neurolinks-proxy

Proxy HTTP seguro para reemplazar los endpoints externos de Dusk Codes usados por el backoffice.

## Dominios esperados

- Google APIs: `https://google-proxy.clientesneurolinks.com`
- OpenAI: `https://proxy.clientesneurolinks.com/v1`

Ambos dominios deben apuntar a este mismo servicio.

## Variables obligatorias en produccion

```env
NODE_ENV=production
PORT=3000
PROXY_AUTH_TOKEN=una_clave_larga_random_de_minimo_32_caracteres
TRUST_PROXY=true
```

## Variables opcionales

```env
MAX_BODY_SIZE=30mb
REQUEST_TIMEOUT_MS=180000
MAX_CONCURRENT_REQUESTS=1000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=1200
LOG_LEVEL=info
KEEP_ALIVE_TIMEOUT_MS=65000
HEADERS_TIMEOUT_MS=66000
SERVER_REQUEST_TIMEOUT_MS=190000
```

## Variables en neurolinks-backoffice

El backoffice debe tener el mismo token:

```env
PROXY_AUTH_TOKEN=la_misma_clave_larga
GOOGLE_PROXY_URL=https://google-proxy.clientesneurolinks.com
OPENAI_BASE_URL=https://proxy.clientesneurolinks.com/v1
```

## Pruebas

```bash
npm run check
npm start
```

Healthcheck publico:

```txt
https://google-proxy.clientesneurolinks.com/health
https://proxy.clientesneurolinks.com/health
```

Respuesta esperada:

```json
{"ok":true,"service":"neurolinks-proxy"}
```

## Seguridad

- En `NODE_ENV=production`, `PROXY_AUTH_TOKEN` es obligatorio.
- El proxy solo acepta hosts Google permitidos y `api.openai.com`.
- El token se envia con `x-proxy-token`.
- No funciona como proxy abierto hacia cualquier dominio.