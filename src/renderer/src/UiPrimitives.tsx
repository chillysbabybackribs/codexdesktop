import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';

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

export function UiTooltip({
  children,
  className = '',
  content,
  side = 'top',
  sideOffset = 7,
}: {
  children: ReactElement;
  className?: string;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className={`ui-tooltip ${className}`.trim()}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={10}
        >
          {content}
          <TooltipPrimitive.Arrow className="ui-tooltip-arrow" width={8} height={4} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

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
  return (
    <UiTooltip
      content={
        <>
          <span>{tooltip}</span>
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </>
      }
      side={side}
    >
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        className={`ui-icon-button ${className}`.trim()}
        aria-label={label}
        disabled={disabled}
      >
        {children}
      </button>
    </UiTooltip>
  );
});
