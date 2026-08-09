import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { bootstrap } from "../src/bootstrap.js";
import { obtenerDashboard } from "../src/services/dashboardService.js";
import { configureSqlite } from "../src/services/sqlitePerformance.js";

bootstrap();

const prisma = new PrismaClient();

const queries = {
  "ventas sin filtros": `
    SELECT id FROM "Venta"
    ORDER BY "fecha" DESC, "nroDoc" ASC
    LIMIT 25 OFFSET 0
  `,
  "ventas por fecha y vendedor": `
    SELECT id FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "vendedor" = ''
    ORDER BY "fecha" DESC, "nroDoc" ASC
    LIMIT 25 OFFSET 0
  `,
  "ventas por fecha y canal": `
    SELECT id FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "canal" = ''
    ORDER BY "fecha" DESC, "nroDoc" ASC
    LIMIT 25 OFFSET 0
  `,
  "ventas por fecha y ciudad": `
    SELECT id FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "ciudad" = ''
    ORDER BY "fecha" DESC, "nroDoc" ASC
    LIMIT 25 OFFSET 0
  `,
  "ventas por fecha y zona": `
    SELECT id FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "zona" = ''
    ORDER BY "fecha" DESC, "nroDoc" ASC
    LIMIT 25 OFFSET 0
  `,
  "kpi por fecha y vendedor": `
    SELECT SUM("montoVtaNetaGua") FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "vendedor" = ''
  `,
  "ranking por fecha y vendedor": `
    SELECT "ciudad", SUM("montoVtaNetaGua")
    FROM "Venta"
    WHERE "fecha" >= 0 AND "fecha" < 32503680000000 AND "vendedor" = ''
    GROUP BY "ciudad"
    ORDER BY SUM("montoVtaNetaGua") DESC
    LIMIT 7
  `,
} as const;

try {
  await configureSqlite(prisma);

  for (const [name, sql] of Object.entries(queries)) {
    const plan = await prisma.$queryRawUnsafe<Array<{ detail: string }>>(
      `EXPLAIN QUERY PLAN ${sql}`,
    );
    console.log(`\n${name}`);
    for (const row of plan) console.log(`  ${row.detail}`);
  }

  const dashboard = await obtenerDashboard(prisma, "", "", {});
  console.log(
    `\nDashboard verificado: ${dashboard.ventasPorDia.length} series, ` +
      `${dashboard.ventasPorVendedor.length} vendedores`,
  );
} finally {
  await prisma.$disconnect();
}
