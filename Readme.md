# jssuh

jssuh reads bw replays =)

[![NPM](https://img.shields.io/npm/v/jssuh.svg?style=flat)](https://www.npmjs.org/package/jssuh)

[![NPM](https://nodei.co/npm/jssuh.png)](https://www.npmjs.org/package/jssuh)

The most notable thing not currently implemented is action-specific data: The library can
read actions and exposes their raw bytes, but understanding the data is currently left to user.

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
  // Game type (melee, ums, etc). Currently just exposed as a integer.
  gameType,
  // Game type modifier (Top vs bottom team layout, greed victory conditions, etc).
  gameSubtype,
  // Array of players in the game.
  players,
  // The duration of the game, in frames (1 / 24th of a second on fastest speed).
  durationFrames,
  // Initial random seed, which is also the timestamp of the replay.
  seed,
  // True if the replay uses StarCraft Remastered format, false for older replays.
  remastered,
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

## parser.pipeChk(stream)
The replay's map (scenario.chk) can be accessed with `parser.pipeChk(stream)`. See
[bw-chk](https://github.com/neivv/bw-chk) for parsing the map data.

## parser.scrSection(tag, size, callback)
SC:R replay format can have arbitrary byte streams that are identified with a 4-byte tag
string.

If you know how the section's expected size, you can give the parser a callback
to run with section's data. Note that if the replay doesn't contain a section with the tag,
there won't be an error, the callback will just not be run.

All currently known official SC:R byte streams use the same split-to-chunk compression as the
main replay, but the format can allow arbitrary data to be added. Use `rawScrSection` if you
the extended section does not use the regular compression

Example:
```javascript
parser.scrSection('LMTS', 0x1c, bytes => {
  // process...
})
```

## parser.rawScrSection(tag, callback)
Forwards SC:R replay section to a callback without assuming anything about it.

While all Blizzrd's replay sections (as of writing this) use the compression that
`parser.scrSection` can be used to decompress for you, `rawScrSection` can be used to access the
raw bytes for sections that use some other format or are not compressed at all.

Similar to `scrSection`, if the replay doesn't contain a section with the tag,
there won't be an error, the callback will just not be run.

Example:
```javascript
parser.rawScrSection('Sbat', bytes => {
  // process ShieldBattery extension ...
})
```
