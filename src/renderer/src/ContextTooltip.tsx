import type { ReactElement } from 'react';
import { UiTooltip } from './UiPrimitives';

export function ContextTooltip({
  available,
  children,
  compacting,
  disabledTrigger = false,
  percent,
}: {
  available: boolean;
  children: ReactElement;
  compacting: boolean;
  disabledTrigger?: boolean;
  percent: number;
}): React.JSX.Element {
  const trigger = disabledTrigger ? (
    <span className="ui-tooltip-anchor">{children}</span>
  ) : (
    children
  );

  return (
    <UiTooltip
      className="context-tooltip"
      content={
        <>
          <span className="context-tooltip-label">Context</span>
          {available ? <strong className="context-tooltip-value">{percent}%</strong> : null}
          <span className="context-tooltip-rule" aria-hidden="true" />
          <span className="context-tooltip-action">
            {compacting ? 'Compacting' : available ? 'Compact' : 'After first reply'}
          </span>
        </>
      }
    >
      {trigger}
    </UiTooltip>
  );
}
