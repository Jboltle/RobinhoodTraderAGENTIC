import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// One file for both Railway environments. `railway config plan` against
// production must always report no changes: production is described here, never
// applied from here. Railway does not read this file during deploys.
export default defineRailway((ctx) => {
  // Railway's names are "production" and "Staging"; the match is exact. Anything
  // that is not production gets the staging shape, so an environment this file
  // has never heard of comes up without a Listener and unable to trade real money.
  const isProd = ctx.isEnvironment("production");
  const branch = isProd ? "main" : "staging";
  // Staging services sleep when idle and wake on the next request; production
  // never sleeps. Absent rather than false for production, which has no such key.
  const sleepWhenIdle = isProd ? {} : { sleepApplication: true };

  const Postgres = postgres("Postgres", { region: "us-east4-eqdc4a" });
  // Spread, not replace: the import overwrote the region postgres() had just set,
  // which production tolerates but would leave a new database without one.
  Postgres.deploy = { ...Postgres.deploy, limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } } };
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const RobinhoodTradingServer = service("RobinhoodTradingServer", {
    source: github("Jboltle/RobinhoodTraderAGENTIC", { branch, checkSuites: false, rootDirectory: "server/" }),
    build: { buildCommand: "", buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile.server", nixpacksPlan: { providers: ["...", "node"] }, watchPatterns: ["/server/**"] },
    // One Discord token allows one Listener, so staging runs the trader alone.
    // Production sets no start command and runs the image's CMD, the supervisor
    // that starts the trader and the Listener. This is the supervisor's own
    // trader command; `npm run trader` needs tsx and src/, which the image omits.
    ...(isProd ? {} : { start: "node dist/trader/index.js" }),
    healthcheck: "/health",
    preDeploy: [],
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { limitOverride: { containers: { cpu: 0.5, memoryBytes: 1000000000 } }, ...sleepWhenIdle },
    networking: { privateNetworkEndpoint: "robinhoodtradingserver" },
    // Production only. Railway rejects edge caching on a service with no public
    // address, and a new environment has none until `railway domain` is run, so
    // with this set for staging the whole apply fails and creates nothing.
    ...(isProd ? { cdn: { enabled: true } } : {}),
    env: {
      // The Postgres in the same environment, so staging cannot be pointed at
      // production's database by a typo.
      SUPABASE_DB_URL: Postgres.env.DATABASE_URL,
      // Staging can never place a real-money order: only a paper account trades
      // there (server/src/trader/broker/paperAccount.ts). Production's kill switch
      // stays a value held in Railway so it can be flipped there without a file change.
      TRADE_EXECUTION_MODE: isProd ? preserve() : "paper_only",
      // No Discord token on staging: a Listener cannot run there.
      ...(isProd ? { DISCORD_USER_TOKEN: preserve() } : {}),
      DISCORD_ALLOWED_AUTHOR_IDS: preserve(),
      DISCORD_ALLOWED_CHANNEL_IDS: preserve(),
      DISCORD_RECAP_CHANNEL_IDS: preserve(),
      JEV_API_KEY: preserve(),
      LLM_MODEL: preserve(),
      NODE_ENV: preserve(),
      OPENAI_API_KEY: preserve(),
      RH_TOKENS_VAULT_KEY: preserve(),
    },
  });
  const RobinhoodTraderWebsite = service("RobinhoodTraderWebsite", {
    // Production's site waits for CI before deploying; staging's does not.
    source: github("Jboltle/RobinhoodTraderAGENTIC", { branch, checkSuites: isProd, rootDirectory: "/" }),
    build: { buildCommand: "", buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "/Dockerfile.client", watchPatterns: ["/client/**"] },
    healthcheck: "/health",
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } }, restartPolicyMaxRetries: 5, ...sleepWhenIdle },
    networking: { privateNetworkEndpoint: "robinhoodtraderagentic" },
    ...(isProd ? { cdn: { defaultTtlSeconds: 86400, enabled: true } } : {}), // as on the trader
    env: {
      // Production's value is a fixed address and is left as it is. Staging's is
      // a Railway reference to the trader in its own environment, so the staging
      // site can never drive the production trader. Written as Railway's own
      // ${{ }} syntax because the SDK's `service.env.X` reference is an object
      // and cannot carry the https:// prefix.
      API_URL: isProd ? preserve() : "https://${{RobinhoodTradingServer.RAILWAY_PUBLIC_DOMAIN}}",
    },
  });

  return project("RobinhoodTrader", {
    variables: { managed: true },
    resources: [RobinhoodTradingServer, Postgres, RobinhoodTraderWebsite, postgresVolume],
  });
});
