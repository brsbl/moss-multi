import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { TRUSTED } from '@moss-multi/protocol/sync';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import type { SyncEnv } from './env.ts';

/** One authenticated workspace channel per tab, hibernatable and addressed by principal id. */
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };

  override onConnect(connection: Connection, context: ConnectionContext): void {
    const principal = context.request.headers.get(TRUSTED.principal);
    if (principal !== this.name) {
      connection.close(4401, 'refused');
      return;
    }
    const sessionId = context.request.headers.get(TRUSTED.session);
    connection.setState({ sessionId });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    // Clients can keep the channel alive, but can never publish workspace events.
    if (message === 'ping') connection.send('pong');
  }

  async publish(event: WorkspaceEvent): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this.broadcast(JSON.stringify(event));
  }
}
