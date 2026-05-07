import Image from 'next/image';

type LogoProps = {
  variant?: 'wordmark' | 'icon';
  className?: string;
  priority?: boolean;
};

export function Logo({ variant = 'wordmark', className, priority }: LogoProps) {
  if (variant === 'icon') {
    return (
      <Image
        src="/brand/deft-icon.png"
        alt="Deft"
        width={500}
        height={400}
        className={className}
        priority={priority}
      />
    );
  }

  return (
    <>
      <Image
        src="/brand/deft-wordmark-on-light.png"
        alt="Deft"
        width={1000}
        height={400}
        className={`${className ?? ''} block dark:hidden`}
        priority={priority}
      />
      <Image
        src="/brand/deft-wordmark-on-dark.png"
        alt="Deft"
        width={1000}
        height={400}
        className={`${className ?? ''} hidden dark:block`}
        priority={priority}
      />
    </>
  );
}
