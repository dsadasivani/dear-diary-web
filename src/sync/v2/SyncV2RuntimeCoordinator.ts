import type { ProtocolBootstrap, ProtocolBootstrapResult } from './protocol/ProtocolBootstrap';

export interface SyncV2BackgroundWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export class SyncV2RuntimeCoordinator {
  private pullStarted = false;
  private outboxStarted = false;

  constructor(
    private readonly bootstrap: ProtocolBootstrap,
    private readonly pullWorker: SyncV2BackgroundWorker,
    private readonly outboxWorker: SyncV2BackgroundWorker,
  ) {}

  async start(): Promise<ProtocolBootstrapResult> {
    const result = await this.bootstrap.initialize();
    if (result.pullAllowed) {
      await this.pullWorker.start();
      this.pullStarted = true;
    }
    if (result.writesAllowed) {
      await this.outboxWorker.start();
      this.outboxStarted = true;
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this.pullStarted) await this.pullWorker.stop();
    if (this.outboxStarted) await this.outboxWorker.stop();
    this.pullStarted = false;
    this.outboxStarted = false;
  }
}
