import type { Transition, Variants } from 'motion/react';

export const motionTransitions = {
  instant: { duration: 0.1, ease: [0.2, 0, 0, 1] },
  press: { duration: 0.12, ease: [0.2, 0, 0, 1] },
  state: { duration: 0.16, ease: [0.2, 0, 0, 1] },
  page: { duration: 0.24, ease: [0.2, 0, 0, 1] },
  deliberate: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
  exit: { duration: 0.18, ease: [0.4, 0, 1, 1] },
  sheet: { type: 'spring', stiffness: 380, damping: 32, mass: 0.82 },
  sharedObject: { type: 'spring', stiffness: 300, damping: 30, mass: 0.85 },
} satisfies Record<string, Transition>;

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

export const fadeRiseVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
};

export const forwardPageVariants: Variants = {
  hidden: { opacity: 0, x: 14 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -10 },
};

export const backPageVariants: Variants = {
  hidden: { opacity: 0, x: -14 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 10 },
};

export const sheetVariants: Variants = {
  hidden: { opacity: 0, y: '100%' },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: '100%' },
};

export const modalVariants: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.985 },
  visible: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.99 },
};

export const collapseVariants: Variants = {
  hidden: { height: 0, opacity: 0 },
  visible: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

export const staggerContainerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.045, delayChildren: 0.03 } },
};

export const staggerItemVariants = fadeRiseVariants;

export const reducedMotionVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

export const pageMotion = (reduced: boolean | null | undefined) => ({
  variants: reduced ? reducedMotionVariants : forwardPageVariants,
  initial: 'hidden' as const,
  animate: 'visible' as const,
  exit: 'exit' as const,
  transition: reduced ? { duration: 0.01 } : motionTransitions.page,
});
