declare module 'cloudflare:test' {
    interface ProvidedEnv {
        arcane_db: D1Database;
        JWT_SECRET: string;
        ENVIRONMENT: string;
        CF_AI_GATEWAY_ID: string;
        WEB_BASE_URL: string;
        API_BASE_URL: string;
        EMAIL_FROM: string;
        TEST_MIGRATIONS: D1Migration[];
    }
}
