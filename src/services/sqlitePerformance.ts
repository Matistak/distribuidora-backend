import type { PrismaClient } from "@prisma/client";

const PAGINATION_INDEX = "Venta_fecha_nroDoc_idx";

/** Configura la conexión SQLite antes de atender consultas de la aplicación. */
export async function configureSqlite(prisma: PrismaClient) {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "${PAGINATION_INDEX}" ON "Venta" ("fecha" DESC, "nroDoc" ASC)`,
  );
}

/** Actualiza las estadísticas del planificador después de una carga importante. */
export async function optimizeSqlite(prisma: PrismaClient) {
  await prisma.$queryRawUnsafe("PRAGMA optimize");
}
