export const APP_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const resolveAppEnvironment = (): AppEnvironment => {
  const modeDefault = import.meta.env.MODE === 'test' ? 'development' : import.meta.env.MODE;
  const configured = import.meta.env.VITE_APP_ENV?.trim() || modeDefault;
  if (APP_ENVIRONMENTS.includes(configured as AppEnvironment)) {
    return configured as AppEnvironment;
  }
  throw new Error(
    `Unsupported VITE_APP_ENV "${configured}". Expected ${APP_ENVIRONMENTS.join(', ')}.`,
  );
};

export const APP_ENVIRONMENT = resolveAppEnvironment();

export const isProductionEnvironment = APP_ENVIRONMENT === 'production';
