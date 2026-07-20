import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

export function UiProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={250} disableHoverableContent>
      {children}
    </TooltipPrimitive.Provider>
  );
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string;
  tooltip?: string;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    children,
    className = '',
    disabled,
    label,
    shortcut,
    side = 'top',
    tooltip = label,
    type = 'button',
    ...buttonProps
  },
  ref,
) {
  const content = shortcut ? `${tooltip} (${shortcut})` : tooltip;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <button
          {...buttonProps}
          ref={ref}
          type={type}
          className={`ui-icon-button ${className}`.trim()}
          aria-label={label}
          disabled={disabled}
          title={disabled ? content : undefined}
        >
          {children}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className="ui-tooltip"
          side={side}
          sideOffset={7}
          collisionPadding={8}
        >
          <span>{tooltip}</span>
          {shortcut ? <kbd>{shortcut}</kbd> : null}
          <TooltipPrimitive.Arrow className="ui-tooltip-arrow" width={8} height={4} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
});
