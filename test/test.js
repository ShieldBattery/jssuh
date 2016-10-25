'use strict';

const fs = require('fs')
const ReplayParser = require('../')
const { test } = require('tape')

test('No actions', t => {
  const replay = fs.createReadStream('test/empty.rep')
    .pipe(new ReplayParser())
  t.plan(2)
  let ended = false
  const end = f => {
    if (!ended) {
      ended = true
      f()
    }
  }
  replay.on('error', e => end(() => t.fail(e)))
  replay.on('data', () => end(() => t.fail('Should not have any actions')))
  replay.on('replayHeader', () => t.pass('Got replay header'))
  replay.on('finish', () => end(() => t.pass('ok')))
})

test('Bad file', t => {
  const replay = fs.createReadStream('test/not-a-replay.rep')
    .pipe(new ReplayParser())
  t.plan(2)
  let ended = false
  const end = f => {
    if (!ended) {
      ended = true
      f()
    }
  }
  replay.on('error', e => t.deepEqual(e.message, 'Not a replay file'))
  replay.on('data', () => end(() => t.fail('Should not have any actions')))
  replay.on('replayHeader', () => end(() => t.fail('Should not have a header')))
  replay.on('finish', () => end(() => t.pass('ok')))
})

test('Regular replay', t => {
  const replay = fs.createReadStream('test/things.rep')
    .pipe(new ReplayParser())
  t.plan(11)
  replay.on('replayHeader', header => {
    t.deepEqual(header.players.length, 4)
    t.deepEqual(header.gameName, 'neiv')
    t.deepEqual(header.mapName, 'Shadowlands')
    t.deepEqual(header.gameType, 15)
    t.deepEqual(header.gameSubtype, 2)
    t.deepEqual(header.durationFrames, 894)
    for (const player of header.players) {
      if (player.name === 'neiv') {
        t.deepEqual(player.race, 'zerg')
        t.deepEqual(player.team, 1)
        t.deepEqual(player.isComputer, false)
      }
      if (player.name === 'Auriga Tribe') {
        t.deepEqual(player.isComputer, true)
      }
    }
  })
  replay.on('error', e => t.fail(e))
  replay.on('data', () => { })
  replay.on('finish', () => t.pass('ok'))
})
