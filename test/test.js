'use strict';

const crypto = require('crypto')
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
  t.plan(13)
  replay.on('replayHeader', header => {
    t.deepEqual(header.players.length, 4)
    t.deepEqual(header.gameName, 'neiv')
    t.deepEqual(header.mapName, 'Shadowlands')
    t.deepEqual(header.gameType, 15)
    t.deepEqual(header.gameSubtype, 2)
    t.deepEqual(header.durationFrames, 894)
    t.deepEqual(header.seed, 0x580cbf56)
    t.deepEqual(header.remastered, false)
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

test('Chk extraction', t => {
  t.plan(1)
  const replay = fs.createReadStream('test/things.rep')
    .pipe(new ReplayParser())

  const hash = crypto.createHash('sha1')
  replay.pipeChk(hash)

  replay.resume()
  hash.on('data', x => t.deepEqual(x.toString('hex'), '0abf186309fd202ba1f11511fed57b48669a6e07'))
})

test('Actions', t => {
  // Tests at least following things:
  // - Multiple select actions in a single frame
  // - Players being correct
  // - Action data
  t.plan(7)
  const replay = fs.createReadStream('test/bug1.rep')
    .pipe(new ReplayParser())

  const actions = [
    { id: 0x9, data: Buffer.from([0x4, 0xb, 0xe, 0xc, 0xe, 0xd, 0xe, 0xe, 0xe]) },
    { id: 0x9, data: Buffer.from([0x1, 0x2f, 0xe]) },
    { id: 0x9, data: Buffer.from([0x4, 0xb, 0xe, 0xc, 0xe, 0xd, 0xe, 0xe, 0xe]) },
    { id: 0x9, data: Buffer.from([0x1, 0x2f, 0xe]) },
    { id: 0x9, data: Buffer.from([0x4, 0xb, 0xe, 0xc, 0xe, 0xd, 0xe, 0xe, 0xe]) },
    { id: 0x14, data: Buffer.from([0xce, 0x0, 0x87, 0xe, 0x0, 0x0, 0xe4, 0x0, 0x0]) },
  ]
  replay.on('data', x => {
    if (actions.length) {
      const compare = actions.shift()
      compare.frame = 104
      compare.player = 6
      t.deepEqual(compare, x)
    }
  })
  replay.on('error', e => t.fail(e))
  replay.on('finish', () => t.pass('ok'))
})

test('Missing chk', t => {
  // Should still emit the actions though
  t.plan(1)
  const replay = fs.createReadStream('test/no-chk.rep')
    .pipe(new ReplayParser())

  let actionCount = 0
  replay.on('data', () => {
    actionCount += 1
  })
  let ok = false
  replay.on('error', () => {
    ok = true
    t.deepEqual(actionCount, 16)
  })
  replay.on('end', () => {
    if (!ok) {
      t.fail('Excepted error')
    }
  })
})

test('SCR replay', t => {
  const replay = fs.createReadStream('test/scr_replay.rep')
    .pipe(new ReplayParser())
  t.plan(13)
  replay.on('replayHeader', header => {
    t.deepEqual(header.players.length, 2)
    t.deepEqual(header.gameName, 'u')
    t.deepEqual(header.gameType, 2)
    t.deepEqual(header.gameSubtype, 1)
    t.deepEqual(header.remastered, true)
    for (const player of header.players) {
      if (player.name === 'u') {
        t.deepEqual(player.race, 'terran')
        t.deepEqual(player.isComputer, false)
      }
      if (player.name === 'Sargas Tribe') {
        t.deepEqual(player.race, 'protoss')
        t.deepEqual(player.isComputer, true)
      }
    }
  })
  let actionCount = 0
  replay.on('data', cmd => {
    t.deepEqual(cmd.player, 0)
    actionCount += 1
  })
  replay.on('error', e => t.fail(e))
  replay.on('end', () => {
    t.deepEqual(actionCount, 3)
  })
})

test('Raw api for SCR replay sections', t => {
  const replay = fs.createReadStream('test/scr_replay.rep')
    .pipe(new ReplayParser())
  t.plan(6)
  replay.scrSection('LMTS', 0x1c, limits => {
    const images = limits.readUInt32LE(0)
    const sprites = limits.readUInt32LE(4)
    const lone = limits.readUInt32LE(8)
    const units = limits.readUInt32LE(0xc)
    t.deepEqual(images, 10000)
    t.deepEqual(sprites, 5000)
    t.deepEqual(lone, 1000)
    t.deepEqual(units, 3400)
  })
  replay.scrSection('LMTS', 0x1c, limits => {
    t.pass('Second callback for same section works')
  })
  replay.scrSection('BFIX', 0x8, bfix => {
    t.pass('Got also BFIX section')
  })
  replay.scrSection('UNK2', 0x8, sect => {
    t.fail('This section doesn\'t exist')
  })
})

test('Conflicting SCR section sizes are an error', t => {
  const replay = fs.createReadStream('test/scr_replay.rep')
    .pipe(new ReplayParser())
  t.plan(1)
  t.throws(() => {
    replay.scrSection('BFIX', 0x8, () => {})
    replay.scrSection('BFIX', 0xc, () => {})
  }, /BFIX/)
})

test('Old SCR replay', t => {
  const replay = fs.createReadStream('test/scr_old.rep')
    .pipe(new ReplayParser())
  t.plan(5)
  replay.on('replayHeader', header => {
    t.deepEqual(header.players.length, 2)
    t.deepEqual(header.gameName, 'u')
    t.deepEqual(header.gameType, 3)
    t.deepEqual(header.gameSubtype, 1)
    t.deepEqual(header.remastered, true)
  })
})
