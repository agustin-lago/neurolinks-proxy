# neurolinks-proxy

Proxy HTTP privado para centralizar las conexiones del backoffice hacia APIs externas.

Sirve para que los servicios de Neurolinks usen endpoints propios, con autenticacion por token, control de concurrencia, rate limit y validacion de destinos permitidos.

## Para que sirve

- Reenviar solicitudes hacia Google APIs usando un dominio propio.
- Reenviar solicitudes hacia OpenAI usando un dominio propio.
- Evitar que el backoffice dependa de endpoints externos no controlados por Neurolinks.
- Proteger el acceso mediante `PROXY_AUTH_TOKEN`.
- Limitar abuso con controles de concurrencia y rate limit.

## Dominios esperados

- Google APIs: `https://google-proxy.clientesneurolinks.com`
- OpenAI: `https://proxy.clientesneurolinks.com/v1`

Ambos dominios pueden apuntar al mismo servicio del proxy.

## Variables obligatorias en produccion

```env
NODE_ENV=production
PORT=3000
PROXY_AUTH_TOKEN=una_clave_larga_random_de_minimo_32_caracteres
```

## Variables recomendadas

```env
MAX_CONCURRENT_REQUESTS=20000
RATE_LIMIT_MAX=120000
REQUEST_TIMEOUT_MS=180000
```

## Variables opcionales

```env
MAX_BODY_SIZE=30mb
RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=loopback
LOG_LEVEL=info
KEEP_ALIVE_TIMEOUT_MS=65000
HEADERS_TIMEOUT_MS=66000
SERVER_REQUEST_TIMEOUT_MS=190000
```

## Variables en neurolinks-backoffice

El backoffice debe usar el mismo token configurado en este proxy:

```env
PROXY_AUTH_TOKEN=la_misma_clave_larga
GOOGLE_PROXY_URL=https://google-proxy.clientesneurolinks.com
OPENAI_BASE_URL=https://proxy.clientesneurolinks.com/v1
```

## Pruebas locales

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
- El token debe tener al menos 32 caracteres.
- El token se envia con el header `x-proxy-token`.
- El proxy solo permite destinos externos predefinidos.
- No funciona como proxy abierto hacia cualquier dominio.