import { beginPake, finishPake, type SessionKeys } from '@skillspore/protocol';
import { authenticatePeer, connectWebRtc, type PeerSession } from './webrtc.js';
import { RendezvousClient, type RendezvousSessionInfo } from './rendezvous.js';

export interface OpenRendezvousSession {
  rendezvous: RendezvousClient;
  info: RendezvousSessionInfo;
}

export async function createRendezvousSession(serverUrl: string): Promise<OpenRendezvousSession> {
  const { client: rendezvous, info } = await RendezvousClient.connect(serverUrl, {
    role: 'sender',
  });
  return { rendezvous, info };
}

export async function joinRendezvousSession(
  serverUrl: string,
  nameplate: string
): Promise<OpenRendezvousSession> {
  const { client: rendezvous, info } = await RendezvousClient.connect(serverUrl, {
    role: 'receiver',
    nameplate,
  });
  return { rendezvous, info };
}

export async function connectSecurePeer(input: {
  openSession: OpenRendezvousSession;
  secret: string;
  role: 'sender' | 'receiver';
  iceTransportPolicy?: 'all' | 'relay';
}): Promise<{ session: PeerSession; keys: SessionKeys }> {
  const { rendezvous, info } = input.openSession;
  const iceServers = await rendezvous.waitUntilPaired(info.expiresAt);
  const sid = Buffer.from(info.sid, 'base64url');
  const state = await beginPake({ secret: input.secret, sid, role: input.role });
  rendezvous.sendRelay({
    type: 'pake-share',
    share: Buffer.from(state.share).toString('base64url'),
  });
  let peerShare: Uint8Array | undefined;
  while (!peerShare) {
    const message = await rendezvous.receiveRelay();
    if (message.type === 'pake-share') peerShare = Buffer.from(message.share, 'base64url');
  }
  const keys = finishPake(state, peerShare);
  const session = await connectWebRtc({
    role: input.role,
    rendezvous,
    iceServers,
    iceTransportPolicy: input.iceTransportPolicy ?? 'all',
  });
  try {
    await authenticatePeer({
      session,
      keys,
      sid: info.sid,
      nameplate: info.nameplate,
    });
  } catch (error) {
    if (input.role === 'sender') rendezvous.markAttemptFailed();
    session.close();
    throw error;
  }
  return { session, keys };
}
