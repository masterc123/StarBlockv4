import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isAi: boolean;
  aiDifficulty?: 'Easy' | 'Medium' | 'Hard' | 'Brutal';
  team: 1 | 2 | 3 | 4 | 0; // 0 = FFA
  faction: 'Terran Dominion' | 'Zerg Swarm' | 'Protoss Fleet' | 'Protoss Solaris';
  ping: number;
  ready: boolean;
  antiCheatVerified?: boolean;
  antiCheatFlags?: number;
}

interface ChatMessageEntry {
  sender: string;
  text: string;
  time: string;
  channel?: 'ALL' | 'TEAM' | 'SYSTEM';
  team?: number;
}

type LobbyGameMode = '1v1' | '1v2' | '1v3' | '2v2' | 'ffa' | 'custom' | 'team_ai' | 'deathmatch';

interface MultiplayerLobby {
  id: string;
  name: string;
  hostName: string;
  hostId: string;
  mode: LobbyGameMode;
  mapBiome: 'highland' | 'desert' | 'ocean' | 'lava' | 'jungle' | 'random';
  mapName: string;
  maxPlayers: number;
  ping: number;
  status: 'Waiting' | 'Ready' | 'In Progress';
  players: LobbyPlayer[];
  messages: ChatMessageEntry[];
  seed: number;
}

interface LeaverPenaltyRecord {
  until: number;
  offenses: number;
  reason: string;
}

const BIOME_MAP_NAMES: Record<string, string> = {
  highland: 'Koprulu Highland Pass',
  ocean: 'Oceanic Archipelago',
  lava: 'Char Volcanic Rift',
  jungle: 'Bel\'Shir Jungle Basin',
  desert: 'Mar Sara Arid Wastes',
  random: 'Random Frontier Sector'
};

const lobbies: Map<string, MultiplayerLobby> = new Map();
const socketToPlayer: Map<WebSocket, {
  playerId: string;
  clientKey: string;
  lobbyId: string | null;
  name: string;
  orderTimestamps: number[];
  lastShareAt: number;
  lastHeartbeatReq: number;
  antiCheatFlags: number;
}> = new Map();
const leaverPenalties: Map<string, LeaverPenaltyRecord> = new Map();

function getActivePenalty(clientKey: string): LeaverPenaltyRecord | null {
  const rec = leaverPenalties.get(clientKey);
  if (!rec) return null;
  if (Date.now() >= rec.until) {
    return null;
  }
  return rec;
}

function applyLeaverPenalty(clientKey: string, playerName: string, lobbyName: string): LeaverPenaltyRecord {
  const prev = leaverPenalties.get(clientKey);
  const offenses = (prev?.offenses || 0) + 1;
  const durationMs = Math.min(300_000, 60_000 * offenses); // 60s 1st leave, 120s 2nd, up to 300s
  const record: LeaverPenaltyRecord = {
    until: Date.now() + durationMs,
    offenses,
    reason: `Abandoned active match in "${lobbyName}" (Offense #${offenses} — ${Math.round(durationMs / 1000)}s matchmaking lockout)`
  };
  leaverPenalties.set(clientKey, record);
  return record;
}

function broadcastLobbies() {
  const list = Array.from(lobbies.values());
  const msg = JSON.stringify({ type: 's:lobby_list', lobbies: list });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastRoom(lobbyId: string) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const msg = JSON.stringify({ type: 's:room_state', lobby });
  wss.clients.forEach(client => {
    const meta = socketToPlayer.get(client);
    if (meta && meta.lobbyId === lobbyId && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
  broadcastLobbies();
}

function broadcastRoomMessage(lobbyId: string, eventObj: any) {
  const msg = JSON.stringify(eventObj);
  wss.clients.forEach(client => {
    const meta = socketToPlayer.get(client);
    if (meta && meta.lobbyId === lobbyId && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function nowTimeLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function removePlayerFromCurrentLobby(ws: WebSocket, isAbandonMatch = false) {
  const meta = socketToPlayer.get(ws);
  if (!meta || !meta.lobbyId) return;
  const lobbyId = meta.lobbyId;
  const lobby = lobbies.get(lobbyId);
  if (lobby) {
    const wasInProgress = lobby.status === 'In Progress' || isAbandonMatch;
    const leavingPlayer = lobby.players.find(p => p.id === meta.playerId);

    if (wasInProgress && leavingPlayer && !leavingPlayer.isAi) {
      const penalty = applyLeaverPenalty(meta.clientKey, meta.name, lobby.name);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 's:penalty_status',
          penaltyUntil: penalty.until,
          offenses: penalty.offenses,
          reason: penalty.reason
        }));
      }
      const sysMsg: ChatMessageEntry = {
        sender: 'ANTI-LEAVE',
        text: `⚠️ Commander ${meta.name} abandoned the active match! Applied ${Math.round((penalty.until - Date.now()) / 1000)}s matchmaking timeout penalty.`,
        time: nowTimeLabel(),
        channel: 'SYSTEM'
      };
      lobby.messages.push(sysMsg);
      if (lobby.messages.length > 50) lobby.messages.shift();
      broadcastRoomMessage(lobbyId, { type: 's:chat_message', message: sysMsg });
      broadcastRoomMessage(lobbyId, {
        type: 's:player_left_match',
        playerId: meta.playerId,
        playerName: meta.name,
        penaltySeconds: Math.round((penalty.until - Date.now()) / 1000)
      });
    }

    lobby.players = lobby.players.filter(p => p.id !== meta.playerId);
    const remainingHumans = lobby.players.filter(p => !p.isAi);
    if (lobby.players.length === 0) {
      lobbies.delete(lobby.id);
    } else {
      if (remainingHumans.length === 0 && lobby.status === 'In Progress') {
        lobby.status = 'Waiting';
      }
      if (lobby.hostId === meta.playerId) {
        const nextHuman = lobby.players.find(p => !p.isAi) || lobby.players[0];
        nextHuman.isHost = true;
        lobby.hostId = nextHuman.id;
        lobby.hostName = nextHuman.isAi ? 'OPEN COMMAND ROOM' : nextHuman.name;
      }
      broadcastRoom(lobbyId);
    }
  }
  meta.lobbyId = null;
  broadcastLobbies();
}

// REST endpoints for fallback & status inspection
app.get('/api/lobbies', (_req, res) => {
  res.json({ lobbies: Array.from(lobbies.values()) });
});

// WebSocket real-time connection handler
wss.on('connection', (ws) => {
  const defaultPlayerId = `usr_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const defaultPlayerName = `Commander_${Math.floor(Math.random() * 900 + 100)}`;
  socketToPlayer.set(ws, {
    playerId: defaultPlayerId,
    clientKey: defaultPlayerId,
    lobbyId: null,
    name: defaultPlayerName,
    orderTimestamps: [],
    lastShareAt: 0,
    lastHeartbeatReq: 900,
    antiCheatFlags: 0
  });

  // Send initial state to newly connected client
  ws.send(JSON.stringify({
    type: 's:init',
    playerId: defaultPlayerId,
    name: defaultPlayerName,
    lobbies: Array.from(lobbies.values())
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const meta = socketToPlayer.get(ws);
      if (!meta) return;

      if (typeof msg.clientKey === 'string' && msg.clientKey.trim().length > 0) {
        meta.clientKey = msg.clientKey.trim().slice(0, 64);
      }

      switch (msg.type) {
        case 'c:hello': {
          if (typeof msg.name === 'string' && msg.name.trim()) {
            meta.name = msg.name.trim().slice(0, 24);
          }
          const activePenalty = getActivePenalty(meta.clientKey);
          ws.send(JSON.stringify({
            type: 's:penalty_status',
            penaltyUntil: activePenalty ? activePenalty.until : 0,
            offenses: activePenalty ? activePenalty.offenses : 0,
            reason: activePenalty ? activePenalty.reason : ''
          }));
          break;
        }

        case 'c:ping': {
          const measuredPing = Math.max(8, Math.min(999, Math.round(Number(msg.measuredPing) || 18)));
          ws.send(JSON.stringify({
            type: 's:pong',
            clientTs: msg.clientTs || Date.now(),
            serverTs: Date.now()
          }));
          if (meta.lobbyId) {
            const lobby = lobbies.get(meta.lobbyId);
            if (lobby) {
              const player = lobby.players.find(p => p.id === meta.playerId);
              if (player) {
                player.ping = measuredPing;
              }
              const humanPings = lobby.players.filter(p => !p.isAi && p.ping > 0).map(p => p.ping);
              if (humanPings.length > 0) {
                lobby.ping = Math.round(humanPings.reduce((a, b) => a + b, 0) / humanPings.length);
              }
              broadcastRoomMessage(meta.lobbyId, {
                type: 's:ping_update',
                playerId: meta.playerId,
                ping: measuredPing,
                lobbyPing: lobby.ping
              });
            }
          }
          break;
        }

        case 'c:get_lobbies': {
          const activePenalty = getActivePenalty(meta.clientKey);
          if (activePenalty) {
            ws.send(JSON.stringify({
              type: 's:penalty_status',
              penaltyUntil: activePenalty.until,
              offenses: activePenalty.offenses,
              reason: activePenalty.reason
            }));
          }
          ws.send(JSON.stringify({ type: 's:lobby_list', lobbies: Array.from(lobbies.values()) }));
          break;
        }

        case 'c:create_lobby': {
          const activePenalty = getActivePenalty(meta.clientKey);
          if (activePenalty) {
            ws.send(JSON.stringify({
              type: 's:penalty_status',
              penaltyUntil: activePenalty.until,
              offenses: activePenalty.offenses,
              reason: activePenalty.reason
            }));
            ws.send(JSON.stringify({
              type: 's:error',
              message: `Matchmaking Locked (${Math.ceil((activePenalty.until - Date.now()) / 1000)}s remaining): ${activePenalty.reason}`
            }));
            return;
          }

          if (meta.lobbyId) {
            removePlayerFromCurrentLobby(ws, false);
          }

          const lobbyId = `lob_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const mapBiome = (['highland', 'desert', 'ocean', 'lava', 'jungle', 'random'].includes(msg.mapBiome) ? msg.mapBiome : 'highland') as MultiplayerLobby['mapBiome'];
          const mode: LobbyGameMode = msg.mode || 'custom';
          const hostFaction = msg.faction || 'Terran Dominion';
          const hostPlayer: LobbyPlayer = {
            id: meta.playerId,
            name: meta.name,
            isHost: true,
            isAi: false,
            team: 1,
            faction: hostFaction,
            ping: 15,
            ready: true,
            antiCheatVerified: true,
            antiCheatFlags: 0
          };

          // Host always creates a lobby starting with one human slot (the host);
          // Host manually adds AI opponents or waits for human joiners.
          const initialPlayers: LobbyPlayer[] = [hostPlayer];

          const newLobby: MultiplayerLobby = {
            id: lobbyId,
            name: String(msg.name || `${meta.name}'s Match`).slice(0, 48),
            hostName: meta.name,
            hostId: meta.playerId,
            mode,
            mapBiome,
            mapName: BIOME_MAP_NAMES[mapBiome] || 'Koprulu Highland Pass',
            maxPlayers: Math.max(2, Math.min(8, Number(msg.maxPlayers) || 6)),
            ping: 15,
            status: 'Waiting',
            seed: (Number.isFinite(Number(msg.seed)) && Number(msg.seed) > 0)
              ? Math.floor(Number(msg.seed))
              : Math.floor(100000 + Math.random() * 899999),
            players: initialPlayers,
            messages: [
              {
                sender: 'SYSTEM',
                text: `Room created by ${meta.name}.`,
                time: nowTimeLabel(),
                channel: 'SYSTEM'
              }
            ]
          };
          lobbies.set(lobbyId, newLobby);
          meta.lobbyId = lobbyId;
          broadcastRoom(lobbyId);
          break;
        }

        case 'c:join_lobby': {
          const activePenalty = getActivePenalty(meta.clientKey);
          if (activePenalty) {
            ws.send(JSON.stringify({
              type: 's:penalty_status',
              penaltyUntil: activePenalty.until,
              offenses: activePenalty.offenses,
              reason: activePenalty.reason
            }));
            ws.send(JSON.stringify({
              type: 's:error',
              message: `Matchmaking Locked (${Math.ceil((activePenalty.until - Date.now()) / 1000)}s remaining): ${activePenalty.reason}`
            }));
            return;
          }

          const lobby = lobbies.get(msg.lobbyId);
          if (!lobby) {
            ws.send(JSON.stringify({ type: 's:error', message: 'Lobby not found on server.' }));
            return;
          }
          if (lobby.players.length >= lobby.maxPlayers && !lobby.players.some(p => p.id === meta.playerId)) {
            ws.send(JSON.stringify({ type: 's:error', message: 'Lobby is full.' }));
            return;
          }
          meta.lobbyId = lobby.id;
          if (msg.name) meta.name = String(msg.name).slice(0, 24);

          const existingPlayer = lobby.players.find(p => p.id === meta.playerId);
          const hasHumanHost = lobby.players.some(p => !p.isAi && p.id === lobby.hostId);
          if (!existingPlayer) {
            // Assign joining player to Team 2 if Team 1 already has a player and Team 2 is empty, otherwise Team 1
            const team1Count = lobby.players.filter(p => p.team === 1).length;
            const team2Count = lobby.players.filter(p => p.team === 2).length;
            const teamChoice: 1 | 2 | 3 | 4 | 0 = team1Count > team2Count ? 2 : 1;
            const makeHost = !hasHumanHost;
            if (makeHost) {
              lobby.hostId = meta.playerId;
              lobby.hostName = meta.name;
            }
            lobby.players.push({
              id: meta.playerId,
              name: meta.name,
              isHost: makeHost,
              isAi: false,
              team: teamChoice,
              faction: msg.faction || 'Terran Dominion',
              ping: 16,
              ready: true,
              antiCheatVerified: true,
              antiCheatFlags: 0
            });
          }
          broadcastRoom(lobby.id);
          break;
        }

        case 'c:leave_lobby': {
          removePlayerFromCurrentLobby(ws, Boolean(msg.inGameAbandon));
          break;
        }

        case 'c:abandon_match': {
          removePlayerFromCurrentLobby(ws, true);
          break;
        }

        case 'c:update_lobby_config': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can update lobby configuration.'
            }));
            return;
          }
          if (typeof msg.name === 'string' && msg.name.trim()) {
            lobby.name = msg.name.trim().slice(0, 48);
          }
          if (typeof msg.mode === 'string') {
            lobby.mode = msg.mode as LobbyGameMode;
          }
          if (typeof msg.mapBiome === 'string' && ['highland', 'desert', 'ocean', 'lava', 'jungle', 'random'].includes(msg.mapBiome)) {
            lobby.mapBiome = msg.mapBiome as MultiplayerLobby['mapBiome'];
            lobby.mapName = BIOME_MAP_NAMES[lobby.mapBiome] || lobby.mapName;
          }
          if (Number.isFinite(Number(msg.seed)) && Number(msg.seed) > 0) {
            lobby.seed = Math.floor(Number(msg.seed));
          }
          if (Array.isArray(msg.players)) {
            const seenIds = new Set<string>();
            const nextPlayers: LobbyPlayer[] = [];
            for (let idx = 0; idx < Math.min(msg.players.length, lobby.maxPlayers); idx++) {
              const p = msg.players[idx];
              if (!p) continue;
              const isAiSlot = Boolean(p.isAi || p.isBot || p.type === 'ai');
              const pid = String(p.id || p.playerId || (isAiSlot ? `bot_${Date.now()}_${idx}` : meta.playerId));
              if (seenIds.has(pid)) {
                ws.send(JSON.stringify({
                  type: 's:error',
                  message: `Invalid participant configuration: Duplicate participant ID "${pid}".`
                }));
                return;
              }
              seenIds.add(pid);
              const existing = lobby.players.find(ep => ep.id === pid);
              const rawTeam = Number(p.team ?? p.teamId ?? (existing ? existing.team : (isAiSlot ? 2 : 1)));
              const validTeam = ([0, 1, 2, 3, 4].includes(rawTeam) ? rawTeam : (isAiSlot ? 2 : 1)) as LobbyPlayer['team'];
              nextPlayers.push({
                id: pid,
                name: String(p.name || (existing ? existing.name : (isAiSlot ? `[BOT] AI_${idx + 1}` : meta.name))).slice(0, 28),
                isHost: !isAiSlot && pid === lobby.hostId,
                isAi: isAiSlot,
                aiDifficulty: isAiSlot ? (['Easy', 'Medium', 'Hard', 'Insane'].includes(p.aiDifficulty || p.difficulty) ? (p.aiDifficulty || p.difficulty) : 'Hard') : undefined,
                team: validTeam,
                faction: p.faction || (existing ? existing.faction : 'Terran Dominion'),
                ping: isAiSlot ? 0 : (existing ? existing.ping : (Number(p.ping) || 15)),
                ready: isAiSlot ? true : (p.ready !== undefined ? Boolean(p.ready) : (existing ? existing.ready : true)),
                antiCheatVerified: true,
                antiCheatFlags: 0
              });
            }
            if (nextPlayers.length > 0) {
              lobby.players = nextPlayers;
            }
          }
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:update_player': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          const isHostSender = lobby.hostId === meta.playerId;

          // Joiners can never modify another player's slot or host-only settings
          if (!isHostSender) {
            if (msg.playerId !== undefined && msg.playerId !== meta.playerId) {
              ws.send(JSON.stringify({
                type: 's:error',
                message: 'Host permission required: Joiners cannot modify other participants.'
              }));
              return;
            }
            if (
              msg.team !== undefined ||
              msg.mapBiome !== undefined ||
              msg.mode !== undefined ||
              msg.seed !== undefined ||
              msg.aiDifficulty !== undefined ||
              msg.roomName !== undefined
            ) {
              ws.send(JSON.stringify({
                type: 's:error',
                message: 'Host permission required: Joiners can only update their own ready status and faction.'
              }));
              return;
            }
          }

          const targetId = isHostSender ? (msg.playerId || meta.playerId) : meta.playerId;
          const player = lobby.players.find(p => p.id === targetId);
          if (!player) {
            ws.send(JSON.stringify({ type: 's:error', message: 'Participant not found in lobby.' }));
            return;
          }

          if (msg.ready !== undefined) {
            player.ready = Boolean(msg.ready);
          }
          if (msg.faction !== undefined && typeof msg.faction === 'string') {
            if (!player.isAi || isHostSender) {
              player.faction = msg.faction;
            }
          }
          if (isHostSender) {
            if (msg.team !== undefined && [0, 1, 2, 3, 4].includes(Number(msg.team))) {
              player.team = Number(msg.team) as LobbyPlayer['team'];
            }
            if (msg.aiDifficulty !== undefined && player.isAi && ['Easy', 'Medium', 'Hard', 'Insane'].includes(msg.aiDifficulty)) {
              player.aiDifficulty = msg.aiDifficulty;
            }
            if (msg.name !== undefined && !player.isAi) {
              player.name = String(msg.name).slice(0, 24);
              if (player.id === meta.playerId) meta.name = player.name;
              if (player.id === lobby.hostId) lobby.hostName = player.name;
            }
            if (msg.mode !== undefined) {
              lobby.mode = msg.mode;
            }
            if (msg.mapBiome !== undefined && ['highland', 'desert', 'ocean', 'lava', 'jungle', 'random'].includes(msg.mapBiome)) {
              lobby.mapBiome = msg.mapBiome;
              lobby.mapName = BIOME_MAP_NAMES[msg.mapBiome] || lobby.mapName;
            }
          }
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:add_bot': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can add AI participants.'
            }));
            return;
          }
          if (lobby.players.length >= lobby.maxPlayers) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: `Lobby is full (max ${lobby.maxPlayers} participants).`
            }));
            return;
          }
          const diff = ['Easy', 'Medium', 'Hard', 'Insane'].includes(msg.difficulty) ? msg.difficulty : 'Hard';
          const rawTeam = Number(msg.team ?? 2);
          const botTeam: 1 | 2 | 3 | 4 | 0 = ([0, 1, 2, 3, 4].includes(rawTeam) ? rawTeam : 2) as LobbyPlayer['team'];
          const botNames = botTeam === 1
            ? ['Commander_Nova', 'Executor_Tassadar', 'Raynor_Raider', 'Artanis_Synod']
            : ['Zagara_Brood', 'Abathur_Swarm', 'Kerrigan_Hive', 'Dehaka_Pack'];
          const botLabel = msg.name || `[BOT] ${botNames[lobby.players.length % botNames.length]}`;
          const candidateId = msg.botId ? String(msg.botId) : `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          if (lobby.players.some(p => p.id === candidateId)) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: `Duplicate participant ID "${candidateId}".`
            }));
            return;
          }
          lobby.players.push({
            id: candidateId,
            name: botLabel,
            isHost: false,
            isAi: true,
            aiDifficulty: diff,
            team: botTeam,
            faction: msg.faction || (botTeam === 1 ? 'Protoss Fleet' : 'Zerg Swarm'),
            ping: 0,
            ready: true,
            antiCheatVerified: true,
            antiCheatFlags: 0
          });
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:update_bot': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can configure AI participants.'
            }));
            return;
          }
          const bot = lobby.players.find(p => p.id === msg.botId && p.isAi);
          if (!bot) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'AI participant not found.'
            }));
            return;
          }
          if (msg.team !== undefined && [0, 1, 2, 3, 4].includes(Number(msg.team))) {
            bot.team = Number(msg.team) as LobbyPlayer['team'];
          }
          if (msg.faction !== undefined && typeof msg.faction === 'string') {
            bot.faction = msg.faction;
          }
          if (msg.aiDifficulty !== undefined && ['Easy', 'Medium', 'Hard', 'Insane'].includes(msg.aiDifficulty)) {
            bot.aiDifficulty = msg.aiDifficulty;
          }
          if (msg.name !== undefined) {
            bot.name = String(msg.name).slice(0, 28);
          }
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:regen_map': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can change the map seed.'
            }));
            return;
          }
          const candidateSeed = Number(msg.seed);
          lobby.seed = (Number.isFinite(candidateSeed) && candidateSeed > 0)
            ? Math.floor(candidateSeed)
            : Math.floor(100000 + Math.random() * 899999);
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:remove_player': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can remove participants.'
            }));
            return;
          }
          if (msg.playerId === lobby.hostId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host cannot remove their own host slot.'
            }));
            return;
          }
          lobby.players = lobby.players.filter(p => p.id !== msg.playerId);
          broadcastRoom(meta.lobbyId);
          break;
        }

        case 'c:chat': {
          if (!meta.lobbyId || !msg.text) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          const senderPlayer = lobby.players.find(p => p.id === meta.playerId);
          const channel: 'ALL' | 'TEAM' = msg.channel === 'TEAM' ? 'TEAM' : 'ALL';
          const senderTeam = senderPlayer ? senderPlayer.team : 1;
          const chatEntry: ChatMessageEntry = {
            sender: meta.name,
            text: String(msg.text).slice(0, 160),
            time: nowTimeLabel(),
            channel,
            team: senderTeam
          };
          lobby.messages.push(chatEntry);
          if (lobby.messages.length > 50) lobby.messages.shift();

          if (channel === 'TEAM') {
            wss.clients.forEach(client => {
              const cMeta = socketToPlayer.get(client);
              if (cMeta && cMeta.lobbyId === meta.lobbyId && client.readyState === WebSocket.OPEN) {
                const cPlayer = lobby.players.find(p => p.id === cMeta.playerId);
                if (!cPlayer || cPlayer.team === senderTeam) {
                  client.send(JSON.stringify({ type: 's:chat_message', message: chatEntry }));
                }
              }
            });
          } else {
            broadcastRoomMessage(meta.lobbyId, { type: 's:chat_message', message: chatEntry });
          }
          break;
        }

        case 'c:share_resources': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;

          const now = Date.now();
          if (now - meta.lastShareAt < 400) {
            meta.antiCheatFlags++;
            ws.send(JSON.stringify({
              type: 's:anticheat_alert',
              severity: 'warning',
              message: 'Valkyrie Anti-Cheat: Resource transfer rate limit exceeded.'
            }));
            return;
          }

          const minerals = Math.max(0, Math.round(Number(msg.minerals) || 0));
          const gems = Math.max(0, Math.round(Number(msg.gems) || 0));

          // Anti-cheat validation on transfer packet bounds
          if ((minerals === 0 && gems === 0) || minerals > 1000 || gems > 250) {
            meta.antiCheatFlags++;
            broadcastRoomMessage(meta.lobbyId, {
              type: 's:anticheat_alert',
              severity: 'critical',
              playerId: meta.playerId,
              playerName: meta.name,
              message: `Valkyrie Anti-Cheat blocked invalid resource packet from ${meta.name} (${minerals}M / ${gems}G).`
            });
            return;
          }

          meta.lastShareAt = now;
          const targetPlayer = lobby.players.find(p => p.id === msg.toPlayerId) || lobby.players.find(p => p.id !== meta.playerId);
          const toName = targetPlayer ? targetPlayer.name : (msg.toPlayerName || 'Allied Commander');
          const toId = targetPlayer ? targetPlayer.id : (msg.toPlayerId || 'ally');

          broadcastRoomMessage(meta.lobbyId, {
            type: 's:share_resources',
            fromId: meta.playerId,
            fromName: meta.name,
            toId,
            toName,
            minerals,
            gems
          });

          const resourceParts: string[] = [];
          if (minerals > 0) resourceParts.push(`+${minerals} Minerals`);
          if (gems > 0) resourceParts.push(`+${gems} Raw Gems`);

          const transferMsg: ChatMessageEntry = {
            sender: 'LOGISTICS',
            text: `📦 ${meta.name} transferred ${resourceParts.join(' & ')} to ${toName}.`,
            time: nowTimeLabel(),
            channel: 'SYSTEM'
          };
          lobby.messages.push(transferMsg);
          if (lobby.messages.length > 50) lobby.messages.shift();
          broadcastRoomMessage(meta.lobbyId, { type: 's:chat_message', message: transferMsg });

          if (targetPlayer && targetPlayer.isAi) {
            const botReply: ChatMessageEntry = {
              sender: targetPlayer.name,
              text: `Supply drop received (${resourceParts.join(', ')}). Accelerating vanguard production!`,
              time: nowTimeLabel(),
              channel: 'TEAM',
              team: targetPlayer.team
            };
            lobby.messages.push(botReply);
            if (lobby.messages.length > 50) lobby.messages.shift();
            broadcastRoomMessage(meta.lobbyId, { type: 's:chat_message', message: botReply });
          }
          break;
        }

        case 'c:anticheat_heartbeat': {
          const req = Math.round(Number(msg.req) || 0);
          const gems = Math.round(Number(msg.gems) || 0);
          const unitsCount = Math.round(Number(msg.unitsCount) || 0);
          const buildingsCount = Math.round(Number(msg.buildingsCount) || 0);
          const wave = Math.round(Number(msg.wave) || 1);
          const clientChecksum = Math.round(Number(msg.checksum) || 0);
          const expectedChecksum = (req * 31 + gems * 97 + unitsCount * 13 + buildingsCount * 7 + wave * 53) % 1000003;

          const checksumValid = clientChecksum === expectedChecksum;
          const boundsValid = req >= 0 && req <= 50000 && gems >= 0 && gems <= 10000 && unitsCount >= 0 && unitsCount <= 250;

          if (!checksumValid || !boundsValid) {
            meta.antiCheatFlags++;
            if (meta.lobbyId) {
              const lobby = lobbies.get(meta.lobbyId);
              const p = lobby?.players.find(pl => pl.id === meta.playerId);
              if (p) {
                p.antiCheatVerified = false;
                p.antiCheatFlags = meta.antiCheatFlags;
              }
              broadcastRoomMessage(meta.lobbyId, {
                type: 's:anticheat_alert',
                severity: 'critical',
                playerId: meta.playerId,
                playerName: meta.name,
                message: `⚠️ VALKYRIE ANTI-CHEAT: Memory/Resource anomaly detected on ${meta.name} (Flags: ${meta.antiCheatFlags}).`
              });
            }
          } else {
            meta.lastHeartbeatReq = req;
            if (meta.lobbyId) {
              const lobby = lobbies.get(meta.lobbyId);
              const p = lobby?.players.find(pl => pl.id === meta.playerId);
              if (p) {
                p.antiCheatVerified = true;
              }
            }
            ws.send(JSON.stringify({
              type: 's:anticheat_ok',
              timestamp: Date.now(),
              checksum: expectedChecksum,
              flags: meta.antiCheatFlags
            }));
          }
          break;
        }

        case 'c:start_game': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if (lobby.hostId !== meta.playerId) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: 'Host permission required: Only the lobby host can start the match.'
            }));
            return;
          }
          // Validate final participant roster on the server before starting the match
          const rosterErrors: string[] = [];
          if (!Array.isArray(lobby.players) || lobby.players.length < 2) {
            rosterErrors.push('At least 2 participants are required to start a match.');
          } else {
            const seenIds = new Set<string>();
            const activeTeams = new Set<number>();
            let humanCount = 0;
            lobby.players.forEach((p, idx) => {
              if (!p || !p.id) {
                rosterErrors.push(`Slot ${idx + 1} is missing a valid participant ID.`);
                return;
              }
              if (seenIds.has(p.id)) {
                rosterErrors.push(`Duplicate participant ID "${p.id}".`);
              }
              seenIds.add(p.id);
              const fLower = String(p.faction || '').toLowerCase();
              if (!fLower.includes('terran') && !fLower.includes('protoss') && !fLower.includes('solaris') && !fLower.includes('zerg')) {
                rosterErrors.push(`Participant "${p.name}" has an invalid faction "${p.faction}".`);
              }
              if (typeof p.team !== 'number' || ![0, 1, 2, 3, 4].includes(p.team)) {
                rosterErrors.push(`Participant "${p.name}" has an invalid team assignment "${p.team}".`);
              } else {
                activeTeams.add(p.team === 0 ? (100 + idx) : p.team);
              }
              if (!p.isAi) {
                humanCount++;
                if (p.ready === false) {
                  rosterErrors.push(`Human player "${p.name}" is not ready.`);
                }
              }
            });
            if (humanCount < 1) {
              rosterErrors.push('At least 1 human player is required.');
            }
            if (activeTeams.size < 2) {
              rosterErrors.push('At least 2 opposing teams are required (assign participants to Team 1 and Team 2).');
            }
          }
          if (rosterErrors.length > 0) {
            ws.send(JSON.stringify({
              type: 's:error',
              message: `Cannot start match: ${rosterErrors.join(' ')}`
            }));
            return;
          }

          lobby.status = 'In Progress';
          (lobby as any).seq = 0;
          broadcastRoomMessage(meta.lobbyId, {
            type: 's:game_start',
            lobby,
            seed: lobby.seed,
            hostId: lobby.hostId,
            serverTs: Date.now()
          });
          broadcastLobbies();
          break;
        }

        case 'c:game_order': {
          // Synchronize in-game real-time RTS orders (move, attack, spawn, base) across room members with Anti-Cheat rate limiting & deduplication
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          const now = Date.now();
          meta.orderTimestamps = meta.orderTimestamps.filter(t => now - t < 2000);
          if (meta.orderTimestamps.length > 28) {
            meta.antiCheatFlags++;
            ws.send(JSON.stringify({
              type: 's:anticheat_alert',
              severity: 'warning',
              playerId: meta.playerId,
              playerName: meta.name,
              message: 'Valkyrie Anti-Cheat: Command packet flood throttled (>28 APM burst / 2s).'
            }));
            return;
          }
          meta.orderTimestamps.push(now);

          const orderObj = msg.order && typeof msg.order === 'object' ? msg.order : {};
          const orderId = orderObj.orderId || `${meta.playerId}_${now}_${Math.floor(Math.random() * 10000)}`;
          if (!(lobby as any)._seenOrders) (lobby as any)._seenOrders = new Set<string>();
          const seenSet: Set<string> = (lobby as any)._seenOrders;
          if (seenSet.has(orderId)) return;
          seenSet.add(orderId);
          if (seenSet.size > 500) {
            const oldest = seenSet.values().next().value;
            if (oldest) seenSet.delete(oldest);
          }

          const nextSeq = ((lobby as any).seq || 0) + 1;
          (lobby as any).seq = nextSeq;

          broadcastRoomMessage(meta.lobbyId, {
            type: 's:game_order',
            senderId: meta.playerId,
            seq: nextSeq,
            serverTs: now,
            order: { ...orderObj, orderId, seq: nextSeq }
          });
          break;
        }

        case 'c:state_snapshot': {
          if (!meta.lobbyId || !msg.snapshot) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          const nextSeq = ((lobby as any).seq || 0) + 1;
          (lobby as any).seq = nextSeq;
          (lobby as any).lastSnapshot = msg.snapshot;
          broadcastRoomMessage(meta.lobbyId, {
            type: 's:state_snapshot',
            senderId: meta.playerId,
            seq: nextSeq,
            serverTs: Date.now(),
            snapshot: msg.snapshot
          });
          break;
        }

        case 'c:request_sync': {
          if (!meta.lobbyId) return;
          const lobby = lobbies.get(meta.lobbyId);
          if (!lobby) return;
          if ((lobby as any).lastSnapshot) {
            ws.send(JSON.stringify({
              type: 's:state_snapshot',
              senderId: lobby.hostId,
              seq: (lobby as any).seq || 0,
              serverTs: Date.now(),
              snapshot: (lobby as any).lastSnapshot
            }));
          } else {
            broadcastRoomMessage(meta.lobbyId, {
              type: 's:request_sync',
              requesterId: meta.playerId
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
    }
  });

  ws.on('close', () => {
    removePlayerFromCurrentLobby(ws, false);
    socketToPlayer.delete(ws);
    broadcastLobbies();
  });
});

// Vite Middleware for Full-Stack development
async function startServer() {
  const PORT = 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[OUTPOST // SECTOR-09] Server running on http://0.0.0.0:${PORT}`);
    });
    return;
  }

  // Serve static assets from public/ immediately so large scripts & vendor files never block
  app.use(express.static(path.join(__dirname, 'public')));

  let viteMiddleware: any = null;
  const viteReadyPromise = (async () => {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true', watch: process.env.DISABLE_HMR === 'true' ? null : {} },
      appType: 'spa',
    });
    viteMiddleware = vite.middlewares;
    return viteMiddleware;
  })();

  app.use(async (req, res, next) => {
    try {
      const mw = viteMiddleware || (await viteReadyPromise);
      mw(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[OUTPOST // SECTOR-09] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
