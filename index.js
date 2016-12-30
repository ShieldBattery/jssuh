'use strict';

const BufferList = require('bl')
const iconv = require('iconv-lite')
const decodeImplode = require('implode-decoder')

const { Transform, Writable } = require('stream')

// The replay file contains 6 separate blocks, which are in the following format:
// { u32 checksum, u32 chunk_count, { u32 size, u8 data[size] } chunks[chunk_count] }
// The data is split into 0x2000 byte chunks if it is large enough.
// If chunk size is less than the excepted, the chunk has been compressed with implode.

const BLOCK_DECODE_HEADER = 0
const BLOCK_DECODE_CHUNK = 1
const BLOCK_DECODE_DATA = 2
const MAX_CHUNK_SIZE = 0x2000

class BlockDecoder extends Writable {
  constructor() {
    super()
    this._buf = new BufferList()
    this._output = null
    this._blockHandlers = []
    this._state = BLOCK_DECODE_HEADER
    this._blockPos = 0
    this._chunkRemaining = 0
    this._error = false
  }

  // The promise resolves once the entire block has been parsed
  nextBlockHandler(size, handler) {
    return new Promise((res, rej) => {
      this._blockHandlers.push({ size, handler, resolve: res, reject: rej })
      if (this._state === BLOCK_DECODE_HEADER && this._blockHandlers.length === 1) {
        // We didn't have any handler for this block before, so run `process()`
        this._process()
      }
    })
  }

  _write(block, enc, done) {
    if (!this._error) {
      this._buf.append(block)
      this._process()
    }
    done()
  }

  _process() {
    while (!this._error && this._buf.length > 0) {
      switch (this._state) {
        case BLOCK_DECODE_HEADER: {
          if (this._blockHandlers.length === 0) {
            return
          }
          const blockSize = this._blockHandlers[0].size
          // Empty blocks don't even have their header information, so just signal end of block
          // and start decoding the next one.
          if (blockSize === 0) {
            this._blockHandlers[0].handler.end()
            this._blockHandlers.shift()
            break
          }
          if (this._buf.length < 0xc) {
            return
          }
          this._blockPos = 0
          // TODO: Could check the checksum
          const chunks = this._buf.readUInt32LE(4)
          this._buf.consume(8)
          const exceptedChunks = Math.ceil(blockSize / MAX_CHUNK_SIZE)
          if (chunks !== exceptedChunks) {
            const error = new Error(`Excepted ${exceptedChunks} chunks, got ${chunks}`)
            this._blockHandlers[0].reject(error)
            this._error = true
            return
          }
          this._state = BLOCK_DECODE_CHUNK
        } break
        case BLOCK_DECODE_CHUNK: {
          if (this._buf.length < 0x4) {
            return
          }
          const remaining = this._blockHandlers[0].size - this._blockPos
          const outSize = Math.min(remaining, MAX_CHUNK_SIZE)
          const inSize = this._buf.readUInt32LE(0)
          this._buf.consume(4)
          this._chunkRemaining = inSize
          if (this._output) {
            // Remove the possible event listeners that have been added
            // if the previous chunk was decodeImplode-piped to _output
            this._output.unpipe()
          }
          if (outSize === inSize) {
            this._output = this._blockHandlers[0].handler
          } else {
            this._output = decodeImplode()
            this._output.on('error', e => this._blockHandlers[0].reject(e))
            this._output.pipe(this._blockHandlers[0].handler)
          }
          this._state = BLOCK_DECODE_DATA
        } break
        case BLOCK_DECODE_DATA: {
          const size = Math.min(this._chunkRemaining, this._buf.length)
          this._chunkRemaining -= size
          this._output.write(this._buf.slice(0, size))
          this._buf.consume(size)
          if (this._chunkRemaining === 0) {
            this._blockPos += MAX_CHUNK_SIZE
            if (this._blockPos >= this._blockHandlers[0].size) {
              this._state = BLOCK_DECODE_HEADER
              this._output.end()
              this._output = null
              this._blockHandlers[0].resolve()
              this._blockHandlers.shift()
            } else {
              this._state = BLOCK_DECODE_CHUNK
            }
          }
        } break
      }
    }
  }
}

const CMDS = (() => {
  const c = (id, len) => ({ id, length: () => len })
  const fun = (id, func) => ({ id, length: func })
  const saveLength = data => {
    if (data.length < 5) {
      return null
    }
    const pos = data.indexOf(0, 5)
    return 1 + (pos === -1 ? data.length : pos)
  }
  const selectLength = data => {
    if (data.length < 1) {
        return null;
    }
    return 2 + data.readUInt8(0) * 2
  }
  return {
    KEEP_ALIVE: c(0x5, 1),
    SAVE: fun(0x6, saveLength),
    LOAD: fun(0x7, saveLength),
    RESTART: c(0x8, 1),
    SELECT: fun(0x9, selectLength),
    SELECTION_ADD: fun(0xa, selectLength),
    SELECTION_REMOVE: fun(0xb, selectLength),
    BUILD: c(0xc, 8),
    VISION: c(0xd, 3),
    ALLIANCE: c(0xe, 5),
    GAME_SPEED: c(0xf, 2),
    PAUSE: c(0x10, 1),
    RESUME: c(0x11, 1),
    CHEAT: c(0x12, 5),
    HOTKEY: c(0x13, 3),
    RIGHT_CLICK: c(0x14, 10),
    TARGETED_ORDER: c(0x15, 11),
    CANCEL_BUILD: c(0x18, 1),
    CANCEL_MORPH: c(0x19, 1),
    STOP: c(0x1a, 2),
    CARRIER_STOP: c(0x1b, 1),
    REAVER_STOP: c(0x1c, 1),
    ORDER_NOTHING: c(0x1d, 1),
    RETURN_CARGO: c(0x1e, 2),
    TRAIN: c(0x1f, 3),
    CANCEL_TRAIN: c(0x20, 3),
    CLOAK: c(0x21, 2),
    DECLOAK: c(0x22, 2),
    UNIT_MORPH: c(0x23, 3),
    UNSIEGE: c(0x25, 2),
    SIEGE: c(0x26, 2),
    TRAIN_FIGHTER: c(0x27, 1),
    UNLOAD_ALL: c(0x28, 2),
    UNLOAD: c(0x29, 3),
    MERGE_ARCHON: c(0x2a, 1),
    HOLD_POSITION: c(0x2b, 2),
    BURROW: c(0x2c, 2),
    UNBURROW: c(0x2d, 2),
    CANCEL_NUKE: c(0x2e, 1),
    LIFTOFF: c(0x2f, 5),
    TECH: c(0x30, 2),
    CANCEL_TECH: c(0x31, 1),
    UPGRADE: c(0x32, 2),
    CANCEL_UPGRADE: c(0x33, 1),
    CANCEL_ADDON: c(0x34, 1),
    BUILDING_MORPH: c(0x35, 3),
    STIM: c(0x36, 1),
    SYNC: c(0x37, 7),
    VOICE_ENABLE1: c(0x38, 1),
    VOICE_ENABLE2: c(0x39, 1),
    VOICE_SQUELCH1: c(0x3a, 2),
    VOICE_SQUELCH2: c(0x3b, 2),
    START_GAME: c(0x3c, 1),
    DOWNLOAD_PERCENTAGE: c(0x3d, 2),
    CHANGE_GAME_SLOT: c(0x3e, 6),
    NEW_NET_PLAYER: c(0x3f, 8),
    JOINED_GAME: c(0x40, 18),
    CHANGE_RACE: c(0x41, 3),
    TEAM_GAME_TEAM: c(0x42, 2),
    UMS_TEAM: c(0x43, 2),
    MELEE_TEAM: c(0x44, 3),
    SWAP_PLAYERS: c(0x45, 3),
    SAVED_DATA: c(0x48, 13),
    BRIEFING_START: c(0x54, 1),
    LATENCY: c(0x55, 2),
    REPLAY_SPEED: c(0x56, 10),
    LEAVE_GAME: c(0x57, 2),
    MINIMAP_PING: c(0x58, 5),
    MERGE_DARK_ARCHON: c(0x5a, 1),
    MAKE_GAME_PUBLIC: c(0x5b, 1),
    CHAT: c(0x5c, 82),
  }
})()

for (const key of Object.keys(CMDS)) {
  CMDS[key].name = key
  CMDS[CMDS[key].id] = CMDS[key]
}

function commandLength(id, data) {
  const cmd = CMDS[id]
  if (!cmd) {
    return null
  }
  return cmd.length(data)
}

const REPLAY_MAGIC = 0x53526572

class ReplayParser extends Transform {
  constructor(options) {
    const opts = Object.assign({
      encoding: 'auto',
    }, options)
    super({ objectMode: true })

    this._cmdBuf = new BufferList()
    this._decoder = new BlockDecoder()
    this._chkPipe = null

    const decodeToBuffer = size => (
      new Promise((res, rej) => {
        this._decoder.nextBlockHandler(size, new BufferList((err, buf) => {
          if (err) {
            rej(err)
          } else {
            res(buf)
          }
        })).catch(rej)
      })
    )
    const streamBlockTo = (size, func) => (
      new Promise((res, rej) => {
        const stream = new Writable()
        stream._write = (data, enc, done) => {
          try {
            func(data)
          } catch (e) {
            rej(e)
          }
          done()
        }
        this._decoder.nextBlockHandler(size, stream).then(res, rej)
      })
    )

    const magic = decodeToBuffer(0x4)
      .then(buf => {
        if (buf.readUInt32LE(0) !== REPLAY_MAGIC) {
          throw new Error('Not a replay file')
        }
      }, () => {
        throw new Error('Not a replay file')
      })
    const header = magic.then(() => decodeToBuffer(0x279))
      .then(buf => {
        this._setupPlayerMappings(buf)
        this._emitHeader(buf, opts.encoding)
      })
    const cmdsSize = magic.then(() => decodeToBuffer(0x4))
      .then(buf => buf.readUInt32LE(0))

    // Wait for header to be emitted before emitting any commands
    const both = Promise.all([header, cmdsSize]).then(([, b]) => b)
    const cmds = both.then(cmdsSize => streamBlockTo(cmdsSize, data => this._onCommandData(data)))
    const chkSize = both.then(() => decodeToBuffer(0x4))
      .then(buf => buf.readUInt32LE(0))

    const chk = chkSize.then(chkSize => {
      if (this._chkPipe) {
        return this._decoder.nextBlockHandler(chkSize, this._chkPipe)
      } else {
        // Discard
        return streamBlockTo(chkSize, () => {})
      }
    })

    Promise.all([cmds, chk])
      .catch(e => this.emit('error', e))
      .then(() => this.end())
  }

  pipeChk(stream) {
    this._chkPipe = stream
  }

  _setupPlayerMappings(buf) {
    this._stormPlayerToGamePlayer = []
    for (let i = 0; i < 8; i++) {
      const offset = 0xa1 + 0x24 * i
      const stormId = buf.readInt32LE(offset + 0x4)
      if (stormId >= 0) {
        this._stormPlayerToGamePlayer[stormId] = buf.readUInt32LE(offset)
        console.log(`Storm ${stormId} = ${buf.readUInt32LE(offset)}`)
      }
    }
  }

  _emitHeader(buf, encoding) {
    const cstring = buf => {
      let text = buf
      const end = buf.indexOf(0)
      if (end !== -1) {
        text = buf.slice(0, end)
      }
      if (encoding === 'auto') {
        const string = iconv.decode(text, 'cp949')
        if (string.indexOf('\ufffd') !== -1) {
          return iconv.decode(text, 'cp1252')
        } else {
          return string
        }
      } else {
        return iconv.decode(buf, encoding)
      }
    }
    const gameName = cstring(buf.slice(0x18, 0x18 + 0x18))
    const mapName = cstring(buf.slice(0x61, 0x61 + 0x20))
    const gameType = buf.readUInt16LE(0x81)
    const gameSubtype = buf.readUInt16LE(0x83)
    const durationFrames = buf.readUInt32LE(0x1)
    const seed = buf.readUInt32LE(0x8)

    const raceStr = race => {
      switch (race) {
        case 0: return 'zerg'
        case 1: return 'terran'
        case 2: return 'protoss'
        default: return 'unknown'
      }
    }
    const players = []
    // There are actually 12 players, but one can just assume 8-10 be unused and 11 to be neutral
    for (let i = 0; i < 8; i++) {
      const offset = 0xa1 + 0x24 * i
      const type = buf.readUInt8(offset + 0x8)
      // TODO: Not sure if UMS maps can have other types that should be reported here
      if (type === 1 || type === 2) {
        players.push({
          id: buf.readUInt32LE(offset),
          isComputer: type === 1,
          race: raceStr(buf.readUInt8(offset + 0x9)),
          name: cstring(buf.slice(offset + 0xb, offset + 0xb + 0x19)),
          team: buf.readUInt8(offset + 0xa),
        })
      }
    }
    const header = {
      gameName,
      mapName,
      gameType,
      gameSubtype,
      players,
      durationFrames,
      seed,
    }
    this.emit('replayHeader', header)
  }

  _transform(block, enc, done) {
    this._decoder.write(block)
    done()
  }

  _onCommandData(data) {
    this._cmdBuf.append(data)
    while (true) {
      if (this._cmdBuf.length < 5) {
        return
      }
      const frameLength = this._cmdBuf.readUInt8(4)
      const frameEnd = 5 + frameLength
      if (this._cmdBuf.length < frameEnd) {
        return
      }
      const frame = this._cmdBuf.readUInt32LE(0)
      let pos = 5
      while (pos < frameEnd) {
        const player = this._stormPlayerToGamePlayer[this._cmdBuf.readUInt8(pos)]
        pos += 1
        const id = this._cmdBuf.readUInt8(pos)
        const len = commandLength(id, this._cmdBuf.slice(pos + 1))
        if (len === null || pos + len > frameEnd) {
          throw new Error(`Invalid command 0x${id.toString(16)} on frame ${frame}`)
        }
        pos += len

        this.push({
          frame,
          id,
          player,
          data: this._cmdBuf.slice(pos + 1, pos + len),
        })
      }
      this._cmdBuf.consume(frameEnd)
    }
  }

  static commands() {
    return CMDS
  }
}

module.exports = ReplayParser
