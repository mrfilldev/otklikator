import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            STRIPE_SECRET_KEY: "sk_test_dummy",
            STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
            STRIPE_PRICE_ID: "price_test_weekly",
            OPENROUTER_API_KEY: "sk-or-test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
