// Presentation only: the API must still enforce its development-only demo guards.
export const HOSTED_DEMO_ENABLED = process.env.NEXT_PUBLIC_HOSTED_DEMO === 'true';
export const DEMO_ENABLED = HOSTED_DEMO_ENABLED || (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production');
