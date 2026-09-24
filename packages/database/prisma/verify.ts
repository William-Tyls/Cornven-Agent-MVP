import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// This list must be kept in sync with the CHECK constraints defined across
// prisma/migrations/*/migration.sql. It intentionally does not re-verify the
// exact CHECK expression (that is already tested by application-level tests
// and by the database itself at insert time) — this script only confirms the
// constraint was not silently dropped or renamed by a later migration.
const expectedCheckConstraints = [
  'ImportBatch_row_counts_check',
  'InventorySnapshot_quantity_check',
  'RawPosRecord_shape_check',
  'Rental_commission_range_check',
  'Rental_effective_period_check',
  'Sale_amounts_check',
  'Sale_quantity_sign_check',
  'Sale_rate_range_check',
  'SettlementLine_amounts_check',
  'SettlementLine_positive_quantity_check',
  'SettlementRuleVersion_effective_period_check',
  'SettlementRuleVersion_rate_range_check',
  'SettlementRuleVersion_version_check',
  'SettlementRun_amounts_check',
  'SettlementRun_period_check',
  'SettlementRun_rate_range_check',
];

async function main() {
  const rows = await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint WHERE contype = 'c';
  `;
  const existing = new Set(rows.map((row: { conname: string }) => row.conname));

  const missing = expectedCheckConstraints.filter((name) => !existing.has(name));

  if (missing.length > 0) {
    console.error('Missing expected CHECK constraint(s):');
    for (const name of missing) {
      console.error(`  - ${name}`);
    }
    console.error(
      '\nThis usually means a migration was not applied, or a constraint name changed ' +
        'without updating this list. Run `pnpm db:migrate:deploy` and check recent migrations.',
    );
    process.exit(1);
  }

  console.log(`OK: all ${expectedCheckConstraints.length} expected CHECK constraints are present.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
