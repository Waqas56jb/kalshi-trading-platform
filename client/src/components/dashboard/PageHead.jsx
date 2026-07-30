export function PageHead({ title, sub, action }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6 flex-wrap max-sm:items-stretch">
      <div>
        <h1 className="font-display text-2xl font-extrabold tracking-[-.02em] max-[420px]:text-xl">{title}</h1>
        {sub && <div className="text-muted text-[13.5px] mt-[3px]">{sub}</div>}
      </div>
      {action && <div className="max-sm:w-full min-w-0">{action}</div>}
    </div>
  );
}
