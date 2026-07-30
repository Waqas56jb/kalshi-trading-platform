import { Panel } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { useCanvas } from '../../../hooks/useUi';
import { api } from '../../../lib/api';
import { drawBars, drawDonut, drawSparkBars } from '../../../lib/charts';
import { PageHead } from '../PageHead';
import { ErrorBox } from '../Notices';

export default function Analytics() {
  const { data, error } = usePoll(() => api.analytics(30), { intervalMs: 30000 });

  const buckets = data?.buckets ?? [];
  const wr = data?.winRate ?? null;
  const evPerDay = data?.evPerDay ?? [];

  const bucketRef = useCanvas(c => {
    drawBars(c, buckets.map(b => ({ label: b.bucket, value: b.pnl })), {
      valueFormat: v => `$${Math.round(v)}`,
      emptyLabel: 'No settled trades yet',
    });
  }, [buckets.length, JSON.stringify(buckets)]);

  const donutRef = useCanvas(c => {
    drawDonut(c, { won: wr?.won ?? 0, lost: wr?.lost ?? 0 });
  }, [wr?.won, wr?.lost]);

  const evRef = useCanvas(c => {
    drawSparkBars(c, evPerDay.map(d => d.ev_usd), { emptyLabel: 'No orders placed yet' });
  }, [evPerDay.length, JSON.stringify(evPerDay)]);

  return (
    <div className="animate-page-in">
      <PageHead title="Analytics" sub="Where the edge is coming from — computed from your own settled trades" />

      {error && <ErrorBox error={error} />}

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="P&L by UTR gap bucket">
          <canvas ref={bucketRef} height="240" />
        </Panel>
        <Panel title="Win rate — settled trades" bodyClass="p-5 flex items-center justify-center">
          <canvas ref={donutRef} height="240" width="300" />
        </Panel>
      </div>

      <Panel title="EV committed per day (30d)">
        <canvas ref={evRef} height="220" />
      </Panel>
    </div>
  );
}
