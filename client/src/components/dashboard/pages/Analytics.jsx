import { Panel, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { useCanvas } from '../../../hooks/useUi';
import { api, fmtNum } from '../../../lib/api';
import { drawBars, drawDonut, drawSparkBars } from '../../../lib/charts';
import { PageHead } from '../PageHead';
import { ErrorBox } from '../Notices';
import { DatasetExport } from './DatasetExport';

export default function Analytics() {
  const { data, error } = usePoll(() => api.analytics(30), { intervalMs: 30000 });

  const buckets = data?.buckets ?? [];             // P&L by gap — needs settled trades
  const signalBuckets = data?.signalBuckets ?? []; // live signals — available immediately
  const wr = data?.winRate ?? null;
  const evPerDay = data?.evPerDay ?? [];
  const edgePerDay = data?.edgePerDay ?? [];
  const coverage = data?.coverage ?? null;

  const hasSettled = (wr?.settled ?? 0) > 0;

  /* Live model output — real from the first sync. */
  const signalRef = useCanvas(c => {
    drawBars(c, signalBuckets.map(b => ({ label: b.bucket, value: b.signals })), {
      valueFormat: v => String(Math.round(v)),
      emptyLabel: 'No signals yet — run a sync',
    });
  }, [JSON.stringify(signalBuckets)]);

  const edgeBarsRef = useCanvas(c => {
    drawBars(c, signalBuckets.map(b => ({ label: b.bucket, value: b.avg_edge_cents })), {
      valueFormat: v => `${Math.round(v)}¢`,
      emptyLabel: 'No signals yet — run a sync',
    });
  }, [JSON.stringify(signalBuckets)]);

  const edgeDayRef = useCanvas(c => {
    drawSparkBars(c, edgePerDay.map(d => d.edge_cents), {
      emptyLabel: 'No alerts recorded yet',
    });
  }, [JSON.stringify(edgePerDay)]);

  /* Realised performance — only meaningful once positions settle. */
  const bucketRef = useCanvas(c => {
    drawBars(c, buckets.map(b => ({ label: b.bucket, value: b.pnl })), {
      valueFormat: v => `$${Math.round(v)}`,
      emptyLabel: 'No settled positions yet',
    });
  }, [JSON.stringify(buckets)]);

  const donutRef = useCanvas(c => {
    drawDonut(c, { won: wr?.won ?? 0, lost: wr?.lost ?? 0 });
  }, [wr?.won, wr?.lost]);

  const evRef = useCanvas(c => {
    drawSparkBars(c, evPerDay.map(d => d.ev_usd), { emptyLabel: 'No positions taken yet' });
  }, [JSON.stringify(evPerDay)]);

  return (
    <div className="animate-page-in">
      <PageHead
        title="Analytics"
        sub="What the model is finding, and how the positions you took actually resolved"
      />

      {error && <ErrorBox error={error} />}

      <DatasetExport />

      {/* ---- live model output ---- */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="font-display text-[15px] font-bold">Model output — live</h2>
        {coverage && (
          <Tag className="bg-ace-dim text-ace">
            {fmtNum(coverage.priced)} / {fmtNum(coverage.total)} PRICED · {fmtNum(coverage.actionable)} ACTIONABLE
          </Tag>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="Signals by UTR gap bucket">
          <canvas ref={signalRef} height="240" />
        </Panel>
        <Panel title="Average edge by UTR gap bucket">
          <canvas ref={edgeBarsRef} height="240" />
        </Panel>
      </div>

      <Panel title="Edge surfaced per day (30d)">
        <canvas ref={edgeDayRef} height="200" />
      </Panel>

      {/* ---- realised performance ---- */}
      <div className="flex items-center gap-3 mb-4 mt-8">
        <h2 className="font-display text-[15px] font-bold">Realised performance</h2>
        {!hasSettled && (
          <Tag className="bg-white/6 text-muted">AWAITING FIRST SETTLEMENT</Tag>
        )}
      </div>

      {!hasSettled && (
        <div className="mb-4 rounded-card border border-line2 bg-panel p-4 text-[13px] text-muted">
          These three fill in once a position settles. A position settles when its Kalshi market
          resolves and the desk reconciles it — approve an alert to start, then use
          <span className="font-mono text-ace"> Trades → Settle now</span>.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="P&L by UTR gap bucket">
          <canvas ref={bucketRef} height="240" />
        </Panel>
        <Panel title="Win rate — settled positions" bodyClass="p-5 flex items-center justify-center">
          <canvas ref={donutRef} height="240" width="300" />
        </Panel>
      </div>

      <Panel title="EV committed per day (30d)">
        <canvas ref={evRef} height="220" />
      </Panel>
    </div>
  );
}
