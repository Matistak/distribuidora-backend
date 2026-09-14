# Distribuidora Backend

API REST local para cargar archivos Excel y consultar ventas, KPIs, rankings y
registros paginados. Se ejecuta como sidecar de la aplicación Tauri y utiliza
SQLite como base de datos.

## Stack

- **Fastify 5** + TypeScript
- **Prisma** ORM + SQLite
- **xlsx** para parseo de archivos Excel

## Requisitos

- Node.js >= 18
- npm
- SQLite no requiere un servidor separado

## Configuración

Copiá `.env.example` a `.env` antes de ejecutar comandos de Prisma o si
necesitás cambiar la configuración:

```bash
cp .env.example .env
```

| Variable       | Descripción                      | Default                   |
| -------------- | -------------------------------- | ------------------------- |
| `DATABASE_URL` | Archivo SQLite de desarrollo     | `file:./distribuidora.db` |
| `PORT`         | Puerto local del servidor        | `3001`                    |
| `CORS_ORIGIN`  | Orígenes CORS separados por coma | `*`                       |

En desarrollo, la base está en `prisma/distribuidora.db`. En el binario
empaquetado, `src/bootstrap.ts` copia la semilla al directorio de datos de la
aplicación y configura allí `DATABASE_URL`. La semilla del instalador es una
**base vacía con el schema** (generada en `scripts/copy-assets.js` con
`prisma db push`): el cliente arranca sin datos y carga su propio Excel. La
base de `prisma/` no debe considerarse el backup de producción.

Si no existe `.env`, el backend usa automáticamente
`prisma/distribuidora.db` como base SQLite local.

## Instalación

```bash
npm install
npm run db:generate
npm run db:push
npm run dev
```

El backend queda disponible en `http://127.0.0.1:3001`.

## Importación

La carga de un Excel debe:

- Validar que existan las columnas esperadas.
- Insertar las filas dentro de una transacción.
- Usar lotes para importar archivos grandes.
- Evitar duplicados mediante la restricción única del modelo `Venta`.
- Registrar en `Carga` las filas totales, nuevas, omitidas y con errores.

El volumen previsto de 25.000 filas mensuales no requiere una cola de trabajos.
Antes de agregar optimizaciones, se debe probar con al menos 25.000, 300.000 y
1.500.000 filas.

## Endpoints

### Uploads

| Método | Ruta               | Descripción                    |
| ------ | ------------------ | ------------------------------ |
| `POST` | `/api/uploads`     | Subir y procesar archivo Excel |
| `GET`  | `/api/uploads`     | Historial de cargas            |
| `GET`  | `/api/uploads/:id` | Estado de una carga            |
| `GET`  | `/api/uploads/origen` | Si la base externa está configurada (no la consulta) |
| `POST` | `/api/uploads/base` | Importar desde la base externa `{ desde, hasta }` |

### Consultas

| Método | Ruta             | Descripción                                           |
| ------ | ---------------- | ----------------------------------------------------- |
| `GET`  | `/api/dashboard` | KPIs, series y rankings (vendedor, cliente, etc)      |
| `GET`  | `/api/ventas`    | Registros de ventas paginados y filtrables            |
| `GET`  | `/api/filtros`   | Opciones de filtro disponibles (vendedor, canal, etc) |

### Sistema

| Método | Ruta      | Descripción  |
| ------ | --------- | ------------ |
| `GET`  | `/health` | Health check |

### Parámetros de filtro

| Parámetro  | Tipo   | Descripción                                      |
| ---------- | ------ | ------------------------------------------------ |
| `desde`    | string | Fecha inicio (YYYY-MM-DD), para `/api/dashboard` |
| `hasta`    | string | Fecha fin (YYYY-MM-DD), para `/api/dashboard`    |
| `vendedor` | string | Filtrar por vendedor                             |
| `canal`    | string | Filtrar por canal                                |
| `ciudad`   | string | Filtrar por ciudad                               |
| `zona`     | string | Filtrar por zona                                 |

### Paginación (`/api/ventas`)

| Parámetro  | Tipo   | Default | Máximo |
| ---------- | ------ | ------- | ------ |
| `page`     | number | 1       | -      |
| `pageSize` | number | 20      | 100    |

`/api/ventas` acepta también `desde` y `hasta` con formato `YYYY-MM-DD` para
aplicar el mismo rango de fechas que el dashboard.

## Scripts

| Comando           | Descripción                  |
| ----------------- | ---------------------------- |
| `npm run dev`     | Iniciar en modo desarrollo   |
| `npm run build`   | Compilar TypeScript          |
| `npm start`       | Iniciar desde build          |
| `npm run db:push` | Sincronizar schema de Prisma |
| `npm run db:explain` | Mostrar los planes de consulta de SQLite |

## Empaquetado con Tauri

Desde el proyecto del frontend se compila este backend, se prepara el binario
sidecar y se copian la semilla de SQLite y el engine de Prisma:

```bash
node scripts/setup-sidecar.js
npm run tauri:build
```

La aplicación final debe escribir en el directorio de datos de Tauri, no en los
recursos incluidos dentro del instalador.
