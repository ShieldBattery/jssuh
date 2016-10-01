const fs = require('fs')
const ReplayParser = require('./index.js')

const reppi = fs.createReadStream(process.argv[2])
  .pipe(new ReplayParser())

reppi.on('replayHeader', ({ gameName, mapName }) => {
  console.log(`${gameName} on ${mapName}`)
})

reppi.on('data', ({ id, frame, player }) => {
  const name = ReplayParser.commands()[id].name
  console.log(`Command ${name} @ frame ${frame} for player ${player}`)
})

reppi.on('error', err => {
  console.log(`Rip rap nib nab ${err}`)
})
