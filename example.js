/* eslint no-console: ["allow"] */

const fs = require('fs')
const ReplayParser = require('./index.js')

const reppi = fs.createReadStream(process.argv[2])
  .pipe(new ReplayParser())

reppi.on('replayHeader', header => {
  const {
    gameName,
    mapName,
    gameType,
    gameSubtype,
    players,
    durationFrames,
    seed,
  } = header
  console.log(`${gameName} on ${mapName} (Game type ${gameType}, ${gameSubtype})`)

  // Seed is just generated with C stdlib `time()`, so it can be used to figure out timestamp.
  const date = new Date(seed * 1000)
  console.log(`Played on ${date.toLocaleString()}`)

  const minutes = Math.floor(durationFrames / 24 / 60)
  const seconds = Math.floor(durationFrames / 24) % 60
  console.log(`Duration: ${minutes}:${seconds}`)
  for (const { name, id, race, team, isComputer } of players) {
    if (isComputer) {
      console.log(`Computer ${name} (${id}): Race ${race}, team ${team}`)
    } else {
      console.log(`Player ${name} (${id}): Race ${race}, team ${team}`)
    }
  }
})

// `ReplayParser` is a `Transform` stream, which transforms binary data to replay actions.
// But if we arent't interested in actions, we'll need to call `reppi.resume()`, explicity.
reppi.on('data', ({ id, frame, player }) => {
  const name = ReplayParser.commands()[id].name
  console.log(`Command ${name} @ frame ${frame} for player ${player}`)
})

reppi.on('error', err => {
  console.log(`Rip rap nib nab ${err}`)
})
reppi.on('end', err => {
  console.log(`Done`)
})
