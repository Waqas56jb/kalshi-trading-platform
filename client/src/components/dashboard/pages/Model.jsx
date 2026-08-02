import { ModelPanel } from './ModelPanel';
import { PageHead } from '../PageHead';

/**
 * The model, published as its own page. It was living inside a Settings tab
 * and the client reasonably asked where it was — a formula lab and a fitted
 * curve are things a desk looks at daily, not configuration.
 */
export default function Model() {
  return (
    <div className="animate-page-in">
      <PageHead
        title="Model"
        sub="Formula lab and everything the algorithm measures from settled matches — derived, not typed in"
      />
      <ModelPanel />
    </div>
  );
}
