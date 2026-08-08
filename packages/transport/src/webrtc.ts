import { randomUUID } from 'node:crypto';
import nodeDataChannel, { type DataChannel, type PeerConnection } from 'node-datachannel';
import {
  createBindingMac,
  verifyBindingMac,
  PROTOCOL_VERSION,
  type ControlMessage,
  type IceServerConfig,
  type SessionBinding,
  type SessionKeys,
  type SignalingPayload,
  type TransportFingerprint,
} from '@skillspore/protocol';
import { AsyncInbox } from './inbox.js';
import type { RendezvousClient } from './rendezvous.js';

const CONTROL_LABEL = 'skillspore/control/v1';
const FILE_LABEL = 'skillspore/files/v1';
const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const BUFFER_LOW_WATER = 1024 * 1024;
const CONTROL_CHUNK_BYTES = 48 * 1024;
let loggerInitialized = false;

function iceServerUrls(servers: IceServerConfig[]): string[] {
  const urls: string[] = [];
  for (const server of servers) {
    for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
      if (server.username && server.credential && /^(?:turn|turns):/i.test(url)) {
        const separator = url.indexOf(':');
        urls.push(
          `${url.slice(0, separator + 1)}${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${url.slice(separator + 1)}`
        );
      } else {
        urls.push(url);
      }
    }
  }
  return urls;
}

function normalizeFingerprint(fingerprint: TransportFingerprint): TransportFingerprint {
  return {
    algorithm: fingerprint.algorithm.toLowerCase(),
    value: fingerprint.value.toLowerCase().replaceAll(':', ''),
  };
}

function localFingerprint(peer: PeerConnection): TransportFingerprint {
  const sdp = peer.localDescription()?.sdp;
  const match = sdp?.match(/^a=fingerprint:([^\s]+)\s+([^\r\n]+)/m);
  if (!match) throw new Error('WebRTC local certificate fingerprint is unavailable');
  return normalizeFingerprint({ algorithm: match[1]!, value: match[2]! });
}

export class PeerSession {
  private readonly controlInbox = new AsyncInbox<ControlMessage>();
  private readonly fileInbox = new AsyncInbox<Buffer>();
  private readonly controlChunks = new Map<
    string,
    { total: number; chunks: Array<Buffer | undefined> }
  >();

  constructor(
    private readonly peer: PeerConnection,
    private readonly control: DataChannel,
    private readonly files: DataChannel,
    readonly role: 'sender' | 'receiver'
  ) {
    control.onMessage((message) => {
      if (typeof message !== 'string') {
        this.controlInbox.fail(new Error('Expected text control message'));
        return;
      }
      try {
        const parsed = JSON.parse(message) as
          | ControlMessage
          | { __skillsporeChunk: { id: string; index: number; total: number; data: string } };
        if ('__skillsporeChunk' in parsed) {
          const chunk = parsed.__skillsporeChunk;
          if (
            typeof chunk.id !== 'string' ||
            chunk.id.length > 128 ||
            typeof chunk.data !== 'string' ||
            !Number.isSafeInteger(chunk.index) ||
            !Number.isSafeInteger(chunk.total) ||
            chunk.index < 0 ||
            chunk.total < 1 ||
            chunk.index >= chunk.total ||
            chunk.total > 64
          ) {
            throw new Error('Invalid control chunk');
          }
          if (!this.controlChunks.has(chunk.id) && this.controlChunks.size >= 4) {
            throw new Error('Too many incomplete control messages');
          }
          const decoded = Buffer.from(chunk.data, 'base64url');
          if (decoded.length > CONTROL_CHUNK_BYTES) throw new Error('Control chunk is too large');
          const assembly = this.controlChunks.get(chunk.id) ?? {
            total: chunk.total,
            chunks: Array<Buffer | undefined>(chunk.total).fill(undefined),
          };
          if (assembly.total !== chunk.total || assembly.chunks[chunk.index]) {
            throw new Error('Duplicate or inconsistent control chunk');
          }
          assembly.chunks[chunk.index] = decoded;
          this.controlChunks.set(chunk.id, assembly);
          if (assembly.chunks.every(Boolean)) {
            this.controlChunks.delete(chunk.id);
            this.controlInbox.push(
              JSON.parse(
                Buffer.concat(assembly.chunks as Buffer[]).toString('utf8')
              ) as ControlMessage
            );
          }
        } else {
          this.controlInbox.push(parsed);
        }
      } catch {
        this.controlInbox.fail(new Error('Received invalid control JSON'));
      }
    });
    files.onMessage((message) => {
      if (typeof message === 'string') this.fileInbox.fail(new Error('Expected binary file frame'));
      else if (Buffer.isBuffer(message)) this.fileInbox.push(message);
      else this.fileInbox.push(Buffer.from(new Uint8Array(message)));
    });
    control.onError((error) => this.controlInbox.fail(new Error(error)));
    files.onError((error) => this.fileInbox.fail(new Error(error)));
    files.setBufferedAmountLowThreshold(BUFFER_LOW_WATER);
  }

  get fingerprints(): { local: TransportFingerprint; remote: TransportFingerprint } {
    return {
      local: localFingerprint(this.peer),
      remote: normalizeFingerprint(this.peer.remoteFingerprint()),
    };
  }

  get connectionType(): 'direct' | 'relayed' {
    const pair = this.peer.getSelectedCandidatePair();
    return pair?.local.type.toLowerCase() === 'relay' || pair?.remote.type.toLowerCase() === 'relay'
      ? 'relayed'
      : 'direct';
  }

  sendControl(message: ControlMessage): void {
    const encoded = JSON.stringify(message);
    const bytes = Buffer.from(encoded);
    if (bytes.length <= this.control.maxMessageSize()) {
      if (!this.control.sendMessage(encoded)) throw new Error('Control channel send failed');
      return;
    }
    const id = randomUUID();
    const total = Math.ceil(bytes.length / CONTROL_CHUNK_BYTES);
    if (total > 64) throw new Error('Control message exceeds the protocol limit');
    for (let index = 0; index < total; index++) {
      const chunk = bytes.subarray(index * CONTROL_CHUNK_BYTES, (index + 1) * CONTROL_CHUNK_BYTES);
      const wire = JSON.stringify({
        __skillsporeChunk: { id, index, total, data: chunk.toString('base64url') },
      });
      if (!this.control.sendMessage(wire)) throw new Error('Control channel chunk send failed');
    }
  }

  receiveControl(timeoutMs?: number): Promise<ControlMessage> {
    return this.controlInbox.next(timeoutMs);
  }

  async sendFileFrame(frame: Buffer): Promise<void> {
    if (frame.length > this.files.maxMessageSize())
      throw new Error('File frame exceeds negotiated limit');
    if (this.files.bufferedAmount() >= BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for transfer backpressure')),
          30_000
        );
        timeout.unref();
        this.files.onBufferedAmountLow(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (!this.files.sendMessageBinary(frame)) throw new Error('File channel send failed');
  }

  receiveFileFrame(timeoutMs?: number): Promise<Buffer> {
    return this.fileInbox.next(timeoutMs);
  }

  close(): void {
    this.control.close();
    this.files.close();
    this.peer.close();
  }
}

function waitForOpen(channel: DataChannel): Promise<void> {
  if (channel.isOpen()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out opening ${channel.getLabel()}`)),
      30_000
    );
    timeout.unref();
    channel.onOpen(() => {
      clearTimeout(timeout);
      resolve();
    });
    channel.onError((error) => {
      clearTimeout(timeout);
      reject(new Error(error));
    });
  });
}

export async function connectWebRtc(input: {
  role: 'sender' | 'receiver';
  rendezvous: RendezvousClient;
  iceServers: IceServerConfig[];
}): Promise<PeerSession> {
  if (!loggerInitialized) {
    nodeDataChannel.initLogger('Warning', () => undefined);
    loggerInitialized = true;
  }
  const peer = new nodeDataChannel.PeerConnection(`skillspore-${input.role}`, {
    iceServers: iceServerUrls(input.iceServers),
    enableIceTcp: true,
    maxMessageSize: 128 * 1024,
  });
  peer.onLocalDescription((sdp, descriptionType) => {
    if (descriptionType !== 'offer' && descriptionType !== 'answer') return;
    input.rendezvous.sendRelay({ type: 'description', sdp, descriptionType });
  });
  peer.onLocalCandidate((candidate, mid) => {
    input.rendezvous.sendRelay({ type: 'candidate', candidate, mid });
  });

  let control: DataChannel | undefined;
  let files: DataChannel | undefined;
  let resolveChannels!: () => void;
  const channelsReady = new Promise<void>((resolve) => {
    resolveChannels = resolve;
  });
  const register = (channel: DataChannel) => {
    if (channel.getLabel() === CONTROL_LABEL) control = channel;
    if (channel.getLabel() === FILE_LABEL) files = channel;
    if (control && files) resolveChannels();
  };
  if (input.role === 'sender') {
    register(peer.createDataChannel(CONTROL_LABEL));
    register(peer.createDataChannel(FILE_LABEL));
  } else {
    peer.onDataChannel(register);
  }

  const signalLoop = (async () => {
    while (!control || !files || !control.isOpen() || !files.isOpen()) {
      const signal: SignalingPayload = await input.rendezvous.receiveRelay();
      if (signal.type === 'description') {
        peer.setRemoteDescription(signal.sdp, signal.descriptionType);
      } else if (signal.type === 'candidate') {
        peer.addRemoteCandidate(signal.candidate, signal.mid);
      }
    }
  })();

  await channelsReady;
  await Promise.all([waitForOpen(control!), waitForOpen(files!)]);
  await Promise.race([signalLoop, Promise.resolve()]);
  return new PeerSession(peer, control!, files!, input.role);
}

export async function authenticatePeer(input: {
  session: PeerSession;
  keys: SessionKeys;
  sid: string;
  nameplate: string;
}): Promise<SessionBinding> {
  const fingerprints = input.session.fingerprints;
  const binding: SessionBinding = {
    protocolVersion: PROTOCOL_VERSION,
    sid: input.sid,
    nameplate: input.nameplate,
    initiatorFingerprint:
      input.session.role === 'sender' ? fingerprints.local : fingerprints.remote,
    responderFingerprint:
      input.session.role === 'sender' ? fingerprints.remote : fingerprints.local,
  };
  const peerRole = input.session.role === 'sender' ? 'receiver' : 'sender';
  input.session.sendControl({
    type: 'auth',
    role: input.session.role,
    mac: createBindingMac(input.keys.confirmationKey, binding, input.session.role),
  });
  const received = await input.session.receiveControl();
  if (
    received.type !== 'auth' ||
    received.role !== peerRole ||
    !verifyBindingMac(input.keys.confirmationKey, binding, peerRole, received.mac)
  ) {
    throw new Error('Peer authentication failed: wrong passcode or substituted connection');
  }
  return binding;
}
