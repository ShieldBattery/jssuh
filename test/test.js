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
