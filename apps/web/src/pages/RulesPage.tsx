import { PlaceholderPage } from './PlaceholderPage';

export function RulesPage() {
  return (
    <PlaceholderPage
      title="Settlement rule configuration"
      tier="Tier 3"
      note="No CRUD endpoint exists yet (SettlementRuleVersion table exists in Prisma schema but has no route). Fixed monthly rental stays out of scope for v0.1. Will draft a contract ask for M3."
    />
  );
}
