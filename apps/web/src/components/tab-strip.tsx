import { ReactNode, HTMLAttributes } from 'react';

type Props = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** When true, applies the right-edge fade indicating more content is scrollable. Default true. */
  fade?: boolean;
};

/**
 * Horizontally-scrollable strip with a right-edge mask-fade affordance.
 * Use for tab bars, chip rows, or any chrome where mobile users would otherwise miss off-screen content.
 */
export function TabStrip({ children, fade = true, className = '', ...rest }: Props) {
  const fadeStyle = fade
    ? {
        WebkitMaskImage: 'linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)',
        maskImage: 'linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)',
      }
    : undefined;
  return (
    <div
      role="tablist"
      className={`flex gap-1.5 overflow-x-auto overflow-y-hidden no-scrollbar ${className}`}
      style={fadeStyle}
      {...rest}
    >
      {children}
    </div>
  );
}
