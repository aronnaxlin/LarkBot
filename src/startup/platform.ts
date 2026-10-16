// Lifecycle seams between startup and the configured chat platform. Exactly
// one platform runs per process.

// Bot identity is needed by Pipeline rendering before cold replay; platforms
// that learn it over the network (Feishu) load it in `prepare`.
export interface PlatformIdentity {
  prepare(): Promise<void>;
  botUserId(): string;
}

export interface PlatformRuntime {
  // Register live event handlers. Called once, after the Driver is attached.
  startIngress(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Best-effort work after the platform is live (e.g. Telegram media backfills).
  runPostStartup(): Promise<void>;
}
