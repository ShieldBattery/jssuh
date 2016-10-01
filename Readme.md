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
}
```
