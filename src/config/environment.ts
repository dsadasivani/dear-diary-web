export const APP_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const resolveAppEnvironment = (): AppEnvironment => {
  const viteEnvironment = import.meta.env;
  const mode = viteEnvironment?.MODE;
  const modeDefault = !mode || mode === 'test' ? 'development' : mode;
  const configured = viteEnvironment?.VITE_APP_ENV?.trim() || modeDefault;
  if (APP_ENVIRONMENTS.includes(configured as AppEnvironment)) {
    return configured as AppEnvironment;
  }
  throw new Error(
    `Unsupported VITE_APP_ENV "${configured}". Expected ${APP_ENVIRONMENTS.join(', ')}.`,
  );
};

export const APP_ENVIRONMENT = resolveAppEnvironment();

export const isProductionEnvironment = APP_ENVIRONMENT === 'production';
