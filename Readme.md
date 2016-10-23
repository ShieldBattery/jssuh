# jssuh

jssuh reads bw replays =)
Though it isn't really complete yet.

See [example.js](./example.js) for a simple example.

This module exports a single class, `ReplayParser`, which is a `Transform` stream.
Pipe the replay file to it, and it will output an following object for each action in the replay:

```javascript
{
  // Id number of a player. (Sadly, this library doesn't yet expose any player info)
  player,
  // Frame on which the action was issued.
  frame,
  // Action id.
  id,
  // Action parameters. Maybe there will eventually be support for better action decoding.
  data,
}
```

Additionally, `ReplayParser` will emit a `replayHeader` event once it has parsed the header.
This will always happen before any of the actions have been emitted. The event has the parsed
header information in following format:

```javascript
{
  // The name of the lobby.
  gameName,
  // The map title.
  mapName,
  // Game type (melee, ums, etc). Currently just exposed as a integer
  gameType,
  // Game type modifier (Top vs bottom team layout, greed victory conditions, etc).
  gameSubtype,
  // Array of players in the game.
  players,
}
```

The player objects have the following fields:
```javascript
{
  // Player id. Matters mostly in UMS which can have preplaced units for specific players.
  // (Not sure if this is before or after start location randomization in maps that have it)
  id,
  // Name of the player.
  name,
  // True if the player is a computer, false if human.
  isComputer,
  // One of the following: 'zerg', 'terran', 'protoss', 'unknown'
  race,
  // Team (1-based) in team games and UMS, meaningless otherwise.
  team,
}
```

## Parser options
You can specify the encoding to used for text strings of replay by passing an option object when
constructing the parser:

```javascript
const parser = new ReplayParser({ encoding: 'cp1252' })
```

The default encoding is `auto`, which attempts to use `cp949` and falls back to `cp1252` if it
does not work.
