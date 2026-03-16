import express from 'express';
import { createServer } from 'http';
import { Server, Room } from 'colyseus';
import cors from 'cors';
import { PostHog } from 'posthog-node';

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
});

async function fetchRandomWord() {
  try {
    const response = await fetch('https://random-word-api.herokuapp.com/word?length=5');
    const data = await response.json();
    return data[0].toUpperCase();
  } catch (error) { return "DISCO"; }
}

function validateGuess(guessString, secretWord) {
  const guessArray = guessString.split('');
  const targetLetters = secretWord.split('');
  const statuses = Array(5).fill('absent');

  guessArray.forEach((letter, i) => {
    if (letter === targetLetters[i]) { statuses[i] = 'correct'; targetLetters[i] = ''; }
  });
  guessArray.forEach((letter, i) => {
    if (statuses[i] !== 'correct' && targetLetters.includes(letter)) {
      statuses[i] = 'present';
      const index = targetLetters.indexOf(letter);
      if (index > -1) targetLetters[index] = ''; 
    }
  });
  return statuses;
}

class WordleRoom extends Room {
  onCreate(options) {
    this.maxClients = 8;
    this.roomState = {
      players: [], settings: { mode: 'timed-pvp', timeLimit: 180 },
      phase: 'lobby', secretWord: '',
      coopBoard: Array.from({ length: 6 }, () => Array(5).fill('')),
      coopStatuses: Array.from({ length: 6 }, () => Array(5).fill('empty')),
      coopRow: 0, coopCol: 0
    };

    this.onMessage('update_settings', (client, settings) => {
      this.roomState.settings = settings;
      this.broadcast('settings_updated', settings, { except: client });
    });

    this.onMessage('start_game', async (client) => {
      this.roomState.phase = 'playing';
      this.roomState.secretWord = await fetchRandomWord();
      this.roomState.coopBoard = Array.from({ length: 6 }, () => Array(5).fill(''));
      this.roomState.coopStatuses = Array.from({ length: 6 }, () => Array(5).fill('empty'));
      this.roomState.coopRow = 0; this.roomState.coopCol = 0;
      this.broadcast('game_started', this.roomState.settings);
      posthog.capture({
        distinctId: client.sessionId,
        event: 'game_started',
        properties: { mode: this.roomState.settings.mode, time_limit: this.roomState.settings.timeLimit, player_count: this.roomState.players.length, room_id: this.roomId },
      });
    });

    this.onMessage('coop_input', (client, { key }) => {
      if (this.roomState.coopRow > 5) return;
      if (key === 'BACKSPACE') {
        if (this.roomState.coopCol === 0) return;
        this.roomState.coopCol -= 1;
        this.roomState.coopBoard[this.roomState.coopRow][this.roomState.coopCol] = '';
      } else if (/^[A-Z]$/.test(key)) {
        if (this.roomState.coopCol >= 5) return;
        this.roomState.coopBoard[this.roomState.coopRow][this.roomState.coopCol] = key;
        this.roomState.coopCol += 1;
      }
      this.broadcast('coop_sync', { board: this.roomState.coopBoard, currentRow: this.roomState.coopRow, currentCol: this.roomState.coopCol });
    });

    this.onMessage('submit_guess', async (client, { guessString }) => {
      try {
        const dictResponse = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${guessString}`);
        if (!dictResponse.ok) { client.send('invalid_word'); return; }
      } catch (error) {}

      const statuses = validateGuess(guessString, this.roomState.secretWord);
      
      if (this.roomState.settings.mode === 'coop') {
        this.roomState.coopStatuses[this.roomState.coopRow] = statuses;
        this.roomState.coopRow += 1; this.roomState.coopCol = 0;
        this.broadcast('coop_guess_result', { statuses: this.roomState.coopStatuses, currentRow: this.roomState.coopRow, currentCol: this.roomState.coopCol, guessString });
      } else {
        const player = this.roomState.players.find(p => p.id === client.sessionId);
        if (player) player.guesses.push(statuses);
        client.send('guess_result', { guessString, statuses });
        this.broadcast('opponent_guessed', { playerId: client.sessionId, statuses }, { except: client });
      }

      const isCorrect = statuses.every(s => s === 'correct');
      posthog.capture({
        distinctId: client.sessionId,
        event: 'guess_submitted',
        properties: { mode: this.roomState.settings.mode, is_correct: isCorrect, guess_number: (this.roomState.settings.mode === 'coop' ? this.roomState.coopRow : (this.roomState.players.find(p => p.id === client.sessionId)?.guesses.length ?? 0)), room_id: this.roomId },
      });
      if (isCorrect) {
        this.broadcast('game_over', { winnerId: client.sessionId, word: this.roomState.secretWord });
        posthog.capture({
          distinctId: client.sessionId,
          event: 'game_over',
          properties: { mode: this.roomState.settings.mode, winner_id: client.sessionId, outcome: 'solved', room_id: this.roomId },
        });
      }
    });

    this.onMessage('time_up', (client) => {
      if (this.roomState.phase === 'playing') {
        this.roomState.phase = 'lobby';
        this.broadcast('game_over', { winnerId: 'time_up', word: this.roomState.secretWord });
        posthog.capture({
          distinctId: client.sessionId,
          event: 'game_over',
          properties: { mode: this.roomState.settings.mode, outcome: 'time_up', room_id: this.roomId },
        });
      }
    });

    this.onMessage('return_to_lobby', () => {
      if (this.roomState.phase === 'playing') {
        this.roomState.phase = 'lobby';
        this.roomState.secretWord = '';
        this.roomState.players.forEach(p => p.guesses = []); 
        this.broadcast('room_state_update', this.roomState); 
      }
    });
  }

  onJoin(client, options) {
    const existingPlayer = this.roomState.players.find(p => p.discordId === options.user.id);
    if (existingPlayer) {
      existingPlayer.id = client.sessionId;
      existingPlayer.name = options.user.username;
    } else {
      this.roomState.players.push({ id: client.sessionId, discordId: options.user.id, name: options.user.username, guesses: [] });
    }
    this.broadcast('room_state_update', this.roomState);
    posthog.capture({
      distinctId: client.sessionId,
      event: 'player_joined_room',
      properties: { room_id: this.roomId, player_count: this.roomState.players.length, discord_id: options.user?.id },
    });
  }

  async onLeave(client, consented) {
    if (consented) {
      this.removePlayer(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, 20);
    } catch (e) {
      this.removePlayer(client.sessionId);
    }
  }

  removePlayer(sessionId) {
    const playerIndex = this.roomState.players.findIndex(p => p.id === sessionId);
    if (playerIndex !== -1) {
      this.roomState.players.splice(playerIndex, 1);
      this.broadcast('room_state_update', this.roomState);
    }
  }
}

const app = express();
app.use(cors());

const gameServer = new Server({ server: createServer(app) });
gameServer.define("wordle", WordleRoom).filterBy(['roomId']);

const PORT = process.env.PORT || 3001;
gameServer.listen(PORT, () => console.log(`Colyseus Server running on port ${PORT}`));

process.on('SIGTERM', async () => { await posthog.shutdown(); });
