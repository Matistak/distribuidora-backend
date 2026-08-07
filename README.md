# Distribuidora Backend

API REST para la gestión de ventas de una distribuidora. Permite cargar archivos Excel con registros de ventas y consultar KPIs, rankings y datos paginados con filtros.

## Stack

- **Fastify 5** + TypeScript
- **Prisma** ORM + PostgreSQL
- **xlsx** para parseo de archivos Excel

## Requisitos

- Node.js >= 18
- PostgreSQL

## Configuración

Copiá `.env.example` a `.env` y ajustá las variables:

```bash
cp .env.example .env
```

| Variable        | Descripción                    | Default                |
| --------------- | ------------------------------ | ---------------------- |
| `DATABASE_URL`  | URL de conexión a PostgreSQL   | -                      |
| `PORT`          | Puerto del servidor            | `3001`                 |
| `CORS_ORIGIN`   | Orígenes CORS (separados por ,)| `*`                    |

## Instalación

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Endpoints

### Uploads

| Método | Ruta               | Descripción                    |
| ------ | ------------------ | ------------------------------ |
| `POST` | `/api/uploads`     | Subir y procesar archivo Excel |
| `GET`  | `/api/uploads`     | Historial de cargas            |
| `GET`  | `/api/uploads/:id` | Estado de una carga            |

### Consultas

| Método | Ruta             | Descripción                                             |
| ------ | ---------------- | ------------------------------------------------------- |
| `GET`  | `/api/dashboard` | KPIs, ventas por mes, rankings (vendedor, cliente, etc) |
| `GET`  | `/api/ventas`    | Registros de ventas paginados y filtrables              |
| `GET`  | `/api/filtros`   | Opciones de filtro disponibles (vendedor, canal, etc)   |

### Sistema

| Método | Ruta      | Descripción |
| ------ | --------- | ----------- |
| `GET`  | `/health` | Health check |

### Parámetros de filtro (`/api/dashboard`, `/api/ventas`)

| Parámetro  | Tipo   | Descripción        |
| ---------- | ------ | ------------------ |
| `desde`    | string | Fecha inicio (YYYY-MM-DD) |
| `hasta`    | string | Fecha fin (YYYY-MM-DD)    |
| `vendedor` | string | Filtrar por vendedor      |
| `canal`    | string | Filtrar por canal         |
| `ciudad`   | string | Filtrar por ciudad        |
| `zona`     | string | Filtrar por zona          |

### Paginación (`/api/ventas`)

| Parámetro   | Tipo   | Default | Máximo |
| ----------- | ------ | ------- | ------ |
| `page`      | number | 1       | -      |
| `pageSize`  | number | 20      | 100    |

## Scripts

| Comando           | Descripción                  |
| ----------------- | ---------------------------- |
| `npm run dev`     | Iniciar en modo desarrollo   |
| `npm run build`   | Compilar TypeScript          |
| `npm start`       | Iniciar desde build          |
| `npm run db:push` | Sincronizar schema de Prisma |
