import { Panel } from '../../common';
import { useCanvas } from '../../../hooks/useUi';
import { drawBuckets, drawDonut, drawEvPerDay } from '../../../lib/charts';
import { PageHead } from '../PageHead';

export default function Analytics() {
  const bucketRef = useCanvas(drawBuckets);
  const donutRef = useCanvas(drawDonut);
  const evRef = useCanvas(drawEvPerDay);

  return (
    <div className="animate-page-in">
      <PageHead title="Analytics" sub="Where the edge is coming from" />

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="P&L by UTR gap bucket">
          <canvas ref={bucketRef} height="240" />
        </Panel>
        <Panel title="Win rate — settled trades" bodyClass="p-5 flex items-center justify-center">
          <canvas ref={donutRef} height="240" width="300" />
        </Panel>
      </div>

      <Panel title="EV captured per day (30d)">
        <canvas ref={evRef} height="220" />
      </Panel>
    </div>
  );
}
