/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isAi: boolean;
  aiDifficulty?: 'Easy' | 'Medium' | 'Hard' | 'Insane' | 'Brutal';
  team: 1 | 2 | 3 | 4 | 0; // 0 = FFA
  faction: 'Terran Dominion' | 'Zerg Swarm' | 'Protoss Fleet' | 'Protoss Solaris';
  ping: number;
  ready: boolean;
  antiCheatVerified?: boolean;
  antiCheatFlags?: number;
}

export interface ChatMessageEntry {
  sender: string;
  text: string;
  time: string;
  channel?: 'ALL' | 'TEAM' | 'SYSTEM';
  team?: number;
}

export type LobbyGameMode = '1v1' | '1v2' | '1v3' | '2v2' | 'ffa' | 'custom' | 'team_ai' | 'deathmatch';

export interface MultiplayerLobby {
  id: string;
  name: string;
  hostName: string;
  hostId: string;
  mode: LobbyGameMode;
  mapBiome?: 'highland' | 'desert' | 'ocean' | 'lava' | 'jungle' | 'random';
  mapName: string;
  maxPlayers: number;
  ping: number;
  status: 'Waiting' | 'Ready' | 'In Progress';
  players: LobbyPlayer[];
  messages: ChatMessageEntry[];
  seed?: number;
}

type Listener = (event: { type: string; payload: any }) => void;

class RealtimeMultiplayerClient {
  private ws: WebSocket | null = null;
  private listeners: Set<Listener> = new Set();
  public isConnected = false;
  public connectionState: 'offline' | 'connecting' | 'connected' = 'offline';
  public myPlayerId: string;
  public myPlayerName: string;
  public clientKey: string;
  public currentLobbyId: string | null = null;
  public measuredPing = 0;

  constructor() {
    this.myPlayerId = `usr_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const randomNum = Math.floor(Math.random() * 900 + 100);
    this.myPlayerName = `Commander_${randomNum}`;
    this.clientKey = this.myPlayerId;

    if (typeof window !== 'undefined') {
      try {
        const storedKey = window.localStorage.getItem('OUTPOST_CLIENT_KEY');
        if (storedKey) {
          this.clientKey = storedKey;
        } else {
          window.localStorage.setItem('OUTPOST_CLIENT_KEY', this.clientKey);
        }
      } catch {}
    }

    this.connectWebSocket();
  }

  public connectWebSocket() {
    if (typeof window === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.connectionState = 'connecting';
      this.emit('connection_status', { connected: false, state: 'connecting', transport: 'websocket', wsType: 'multiplayer', url: wsUrl });
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.connectionState = 'connected';
        this.emit('connection_status', { connected: true, state: 'connected', transport: 'websocket', wsType: 'multiplayer', url: wsUrl });
        this.send({ type: 'c:hello', clientKey: this.clientKey, name: this.myPlayerName });
        this.send({ type: 'c:get_lobbies', clientKey: this.clientKey });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleIncoming(data);
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.connectionState = 'offline';
        this.emit('connection_status', { connected: false, state: 'offline', transport: 'offline', wsType: 'multiplayer', url: wsUrl });
      };

      this.ws.onerror = (err) => {
        this.isConnected = false;
        this.connectionState = 'offline';
        console.warn('[MultiplayerWebSocket] Application /ws connection error:', err);
        this.emit('connection_status', { connected: false, state: 'offline', transport: 'offline', wsType: 'multiplayer', url: wsUrl });
      };
    } catch (err) {
      this.isConnected = false;
      this.connectionState = 'offline';
      console.warn('[MultiplayerWebSocket] Failed to initialize /ws connection:', err);
      this.emit('connection_status', { connected: false, state: 'offline', transport: 'offline', wsType: 'multiplayer', url: wsUrl });
    }
  }

  private handleIncoming(data: any) {
    if (!data || !data.type) return;

    if (data.type === 's:init') {
      this.myPlayerId = data.playerId || this.myPlayerId;
      this.emit('lobbies_update', data.lobbies || []);
    } else if (data.type === 's:lobby_list') {
      this.emit('lobbies_update', data.lobbies || []);
    } else if (data.type === 's:room_state') {
      this.emit('room_update', data.lobby);
    } else if (data.type === 's:chat_message') {
      this.emit('chat_message', data.message);
    } else if (data.type === 's:game_start') {
      this.emit('game_start', data);
    } else if (data.type === 's:game_order') {
      this.emit('game_order', data);
    } else if (data.type === 's:pong') {
      const rtt = Math.max(1, Date.now() - (Number(data.clientTs) || Date.now()));
      this.measuredPing = rtt;
      this.emit('ping_measured', { ping: rtt });
    } else if (data.type === 's:ping_update') {
      this.emit('ping_update', data);
    } else if (data.type === 's:share_resources') {
      this.emit('share_resources', data);
    } else if (data.type === 's:penalty_status') {
      this.emit('penalty_status', data);
    } else if (data.type === 's:anticheat_alert') {
      this.emit('anticheat_alert', data);
    } else if (data.type === 's:anticheat_ok') {
      this.emit('anticheat_ok', data);
    } else if (data.type === 's:error') {
      this.emit('server_error', data);
    }
  }

  public send(msg: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const payloadWithKey = { ...msg, clientKey: this.clientKey };
    this.ws.send(JSON.stringify(payloadWithKey));
    return true;
  }

  public subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: string, payload: any) {
    this.listeners.forEach((fn) => fn({ type, payload }));
  }

  public createLobby(name: string, mapBiome = 'highland', maxPlayers = 6) {
    return this.send({
      type: 'c:create_lobby',
      name,
      mapBiome,
      maxPlayers
    });
  }

  public joinLobby(lobbyId: string, name?: string) {
    this.currentLobbyId = lobbyId;
    return this.send({
      type: 'c:join_lobby',
      lobbyId,
      name: name || this.myPlayerName
    });
  }

  public leaveLobby(inGameAbandon = false) {
    this.currentLobbyId = null;
    return this.send({ type: 'c:leave_lobby', inGameAbandon });
  }

  public abandonMatch() {
    this.currentLobbyId = null;
    return this.send({ type: 'c:abandon_match' });
  }

  public updateLobbyConfig(updates: { name?: string; mode?: LobbyGameMode; mapBiome?: string; seed?: number; players?: LobbyPlayer[] }) {
    return this.send({
      type: 'c:update_lobby_config',
      ...updates
    });
  }

  public updatePlayer(updates: Partial<LobbyPlayer> & { playerId?: string; mode?: string; mapBiome?: string }) {
    return this.send({
      type: 'c:update_player',
      ...updates
    });
  }

  public addBot(difficulty: 'Easy' | 'Medium' | 'Hard' | 'Insane' | 'Brutal', team: 1 | 2 | 3 | 4 | 0 = 2, faction?: string) {
    return this.send({
      type: 'c:add_bot',
      difficulty,
      team,
      faction
    });
  }

  public updateBot(botId: string, updates: { team?: 1 | 2 | 3 | 4 | 0; faction?: string; aiDifficulty?: string; name?: string }) {
    return this.send({
      type: 'c:update_bot',
      botId,
      ...updates
    });
  }

  public regenMap(seed?: number) {
    return this.send({
      type: 'c:regen_map',
      seed
    });
  }

  public removePlayer(playerId: string) {
    return this.send({
      type: 'c:remove_player',
      playerId
    });
  }

  public sendChat(text: string, channel: 'ALL' | 'TEAM' = 'ALL') {
    return this.send({
      type: 'c:chat',
      text,
      channel
    });
  }

  public shareResources(toPlayerId: string, toPlayerName: string, minerals: number, gems: number) {
    return this.send({
      type: 'c:share_resources',
      toPlayerId,
      toPlayerName,
      minerals,
      gems
    });
  }

  public sendAntiCheatHeartbeat(digest: { req: number; gems: number; unitsCount: number; buildingsCount: number; wave: number; checksum: number }) {
    return this.send({
      type: 'c:anticheat_heartbeat',
      ...digest
    });
  }

  public startGame() {
    return this.send({ type: 'c:start_game' });
  }

  public sendGameOrder(order: any) {
    return this.send({
      type: 'c:game_order',
      order
    });
  }
}

export const realtimeClient = new RealtimeMultiplayerClient();
