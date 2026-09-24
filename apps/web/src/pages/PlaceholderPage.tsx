export function PlaceholderPage({
  title,
  tier,
  note,
}: {
  title: string;
  tier: 'Tier 1' | 'Tier 2' | 'Tier 3';
  note: string;
}) {
  return (
    <div className="page-wrap">
      <header className="page-head">
        <p className="page-head__eyebrow">
          {tier} <span>· not built yet</span>
        </p>
        <h1>{title}</h1>
      </header>
      <section className="panel">
        <p>{note}</p>
      </section>
    </div>
  );
}
