/* eslint no-console: ["allow"] */

const fs = require('fs')
const ReplayParser = require('./index.js')

const reppi = fs.createReadStream(process.argv[2])
  .pipe(new ReplayParser())

reppi.on('replayHeader', ({ gameName, mapName, gameType, gameSubtype, players }) => {
  console.log(`${gameName} on ${mapName} (Game type ${gameType}, ${gameSubtype})`)
  for (const { name, id, race, team, isComputer } of players) {
    if (isComputer) {
      console.log(`Computer ${name} (${id}): Race ${race}, team ${team}`)
    } else {
      console.log(`Player ${name} (${id}): Race ${race}, team ${team}`)
    }
  }
})

reppi.on('data', ({ id, frame, player }) => {
  const name = ReplayParser.commands()[id].name
  console.log(`Command ${name} @ frame ${frame} for player ${player}`)
})

reppi.on('error', err => {
  console.log(`Rip rap nib nab ${err}`)
})
