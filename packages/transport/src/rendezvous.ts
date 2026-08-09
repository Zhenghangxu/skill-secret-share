import WebSocket from 'ws';
import type {
  ClientRendezvousMessage,
  ServerRendezvousMessage,
  SignalingPayload,
} from '@skillspore/protocol';
import { AsyncInbox } from './inbox.js';

export interface RendezvousSessionInfo {
  nameplate: string;
  sid: string;
  expiresAt: string;
  iceServers: Extract<ServerRendezvousMessage, { type: 'created' }>['iceServers'];
}

export class RendezvousClient {
  private readonly socket: WebSocket;
  private readonly messages = new AsyncInbox<ServerRendezvousMessage>();
  private readonly relays = new AsyncInbox<SignalingPayload>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      try {
        if (raw.toString().length > 256 * 1024) throw new Error('Rendezvous message is too large');
        const message = JSON.parse(raw.toString()) as ServerRendezvousMessage;
        if (message.type === 'relay') this.relays.push(message.payload as SignalingPayload);
        else if (message.type === 'error')
          this.messages.fail(new Error(`${message.code}: ${message.message}`));
        else this.messages.push(message);
      } catch (error) {
        this.messages.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error) => {
      this.messages.fail(error);
      this.relays.fail(error);
    });
    socket.on('close', () => {
      const error = new Error('Rendezvous connection closed');
      this.messages.fail(error);
      this.relays.fail(error);
    });
  }

  static async connect(url: string): Promise<RendezvousClient> {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new RendezvousClient(socket);
  }

  private send(message: ClientRendezvousMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async create(): Promise<RendezvousSessionInfo> {
    this.send({ type: 'create' });
    const message = await this.waitFor('created');
    return message;
  }

  async join(nameplate: string): Promise<RendezvousSessionInfo> {
    this.send({ type: 'join', nameplate });
    const message = await this.waitFor('joined');
    return message;
  }

  async waitUntilPaired(expiresAt: string): Promise<void> {
    const expiresAtMs = Date.parse(expiresAt);
    const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - Date.now()) : 30_000;
    await this.waitFor('paired', timeoutMs);
  }

  sendRelay(payload: SignalingPayload): void {
    this.send({ type: 'relay', payload });
  }

  receiveRelay(timeoutMs = 30_000): Promise<SignalingPayload> {
    return this.relays.next(timeoutMs);
  }

  markAttemptFailed(): void {
    this.send({ type: 'attempt-failed' });
  }

  markComplete(): void {
    this.send({ type: 'complete' });
  }

  close(): void {
    this.socket.close();
  }

  private async waitFor<K extends ServerRendezvousMessage['type']>(
    type: K,
    timeoutMs = 30_000
  ): Promise<Extract<ServerRendezvousMessage, { type: K }>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const message = await this.messages.next(Math.max(1, deadline - Date.now()));
      if (message.type === type) return message as Extract<ServerRendezvousMessage, { type: K }>;
      if (message.type === 'peer-left') throw new Error('Peer left the session');
    }
  }
}
